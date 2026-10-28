import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type DefaultTheme, defineConfig, type MarkdownRenderer } from "vitepress";
import llmstxt from "vitepress-plugin-llms";
import { RULE_INFO } from "../../packages/samesight/src/lint/rule-info.ts";

const REPO = "https://github.com/rayanyedaly/samesight";
const BASE = "/samesight/";

const docsDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = resolve(docsDir, "..");

// The rule pages that exist, in the order lint runs the rules, so the site builds with or
// without them.
const ruleIds = Object.keys(RULE_INFO).filter((id) => existsSync(resolve(docsDir, "rules", `${id}.md`)));
const hasRulesIndex = existsSync(resolve(docsDir, "rules", "index.md"));

const ruleItems: DefaultTheme.SidebarItem[] = [
  ...(hasRulesIndex ? [{ text: "All rules", link: "/rules/" }] : []),
  ...ruleIds.map((id) => ({ text: id, link: `/rules/${id}` })),
];

const isInside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The file a relative link on a page points at, and its anchor; undefined for other links. */
function relativeLink(href: string, page: string): { target: string; rest: string } | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) return undefined;
  const cut = href.search(/[?#]/);
  const path = cut < 0 ? href : href.slice(0, cut);
  return { target: resolve(dirname(page), decodeURIComponent(path)), rest: cut < 0 ? "" : href.slice(cut) };
}

/**
 * Where a relative link should point on the site. The docs link to the rest of the
 * repository with relative paths (../examples/fieldbook) so they work on GitHub; the site
 * only has docs/, so those links go to the file on GitHub instead. So do links to files in
 * docs/ that are not pages (assets/audit-demo.txt), which the build does not copy. Returns
 * undefined for links the site serves.
 */
function siteHref(href: string, page: string): string | undefined {
  const link = relativeLink(href, page);
  if (!link) return undefined;
  const { target, rest } = link;
  const exists = existsSync(target);
  if (isInside(docsDir, target)) {
    // Pages (cli.md, cli, a folder with an index.md) are VitePress's to serve and check; an
    // existing file that is not Markdown (assets/LICENSE) is not a page, whatever its name.
    const page = /\.(md|html)$/.test(target);
    const isPage = !exists ? page || !/\.[^/\\]+$/.test(target) : statSync(target).isDirectory() ? existsSync(join(target, "index.md")) : page;
    if (isPage || (exists && isInside(resolve(docsDir, "public"), target))) return undefined;
  }
  const where = `${relative(repoDir, page)}: the link ${href}`;
  if (!isInside(repoDir, target)) throw new Error(`${where} points outside the repository`);
  // VitePress checks links to pages; these it no longer sees, so check them here.
  if (!exists) throw new Error(`${where} points at ${relative(repoDir, target)}, which does not exist`);
  const kind = statSync(target).isDirectory() ? "tree" : "blob";
  return `${REPO}/${kind}/main/${encodeURI(relative(repoDir, target).split(sep).join("/"))}${rest}`;
}

function repoLinks(md: MarkdownRenderer): void {
  md.core.ruler.push("samesight_repo_links", (state) => {
    const page: unknown = state.env?.path;
    if (typeof page !== "string") return;
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        const href = token.type === "link_open" ? token.attrGet("href") : null;
        const url = href ? siteHref(href, page) : undefined;
        if (url) token.attrSet("href", url);
      }
    }
  });
}

/**
 * The Markdown copies the llms plugin writes (one .md per page, and llms-full.txt with every
 * page) keep the pages' relative links, though llms-full.txt sits at the root and a folder's
 * index.md is written as the folder's name (rules/index.md as rules.md). Point the links the
 * site does not serve at GitHub, as repoLinks does for the HTML, and make links to pages
 * absolute, to the Markdown copy.
 */
function llmsLinks(outDir: string): void {
  // The page a copy was made from: cli.md from cli.md, rules.md from rules/index.md.
  const source = (copy: string) => {
    const page = resolve(docsDir, copy);
    return existsSync(page) ? page : resolve(docsDir, copy.replace(/\.md$/, ""), "index.md");
  };
  for (const file of readdirSync(outDir, { recursive: true, encoding: "utf8" })) {
    const full = file === "llms-full.txt";
    if (!full && (!file.endsWith(".md") || file.startsWith(`assets${sep}`))) continue;
    let page = source(file);
    let fenced = false;
    const lines = readFileSync(join(outDir, file), "utf8")
      .split("\n")
      .map((line) => {
        // In llms-full.txt each page's section starts with its url: "url: /samesight/cli.md".
        if (full && line.startsWith(`url: ${BASE}`) && line.endsWith(".md")) page = source(line.slice(`url: ${BASE}`.length));
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        if (fenced) return line;
        // Links in inline code are examples, not links: the odd parts of the split.
        return line
          .split(/(`[^`]*`)/)
          .map((part, i) =>
            i % 2
              ? part
              : part.replace(/\]\(([^)\s]+)\)/g, (whole, href: string) => {
                  const url = siteHref(href, page) ?? copyHref(href, page) ?? href;
                  // No build step checks these copies' links, so check each site link here.
                  if (url.startsWith(BASE) && !servedAt(outDir, url)) throw new Error(`${file}: the link ${url} points at nothing on the site`);
                  return url === href ? whole : `](${url})`;
                }),
          )
          .join("");
      });
    writeFileSync(join(outDir, file), lines.join("\n"));
  }
}

/** Whether the built site serves a path under BASE: /samesight/cli, /samesight/cli.md, /samesight/rules/. */
function servedAt(outDir: string, url: string): boolean {
  const path = decodeURI(url.slice(BASE.length).replace(/[?#].*$/, ""));
  const file = join(outDir, path);
  return path === "" || existsSync(`${file}.html`) || existsSync(join(file, "index.html")) || (existsSync(file) && statSync(file).isFile());
}

/**
 * The links VitePress does not check, because they are not in a page's text: the nav, the
 * sidebar and the home page's buttons. A renamed page would leave them pointing at nothing.
 */
function checkThemeLinks(outDir: string, theme: DefaultTheme.Config): void {
  const links: string[] = [];
  const walk = (items: unknown): void => {
    for (const item of Array.isArray(items) ? items : []) {
      if (item && typeof item === "object") {
        const { link, items: children } = item as { link?: unknown; items?: unknown };
        if (typeof link === "string") links.push(link);
        walk(children);
      }
    }
  };
  walk(theme.nav);
  walk(theme.sidebar);
  for (const [, link] of readFileSync(resolve(docsDir, "index.md"), "utf8").matchAll(/^\s*link:\s*(\S+)\s*$/gm)) links.push(link as string);
  for (const link of links.filter((l) => l.startsWith("/"))) {
    if (!servedAt(outDir, `${BASE}${link.slice(1)}`)) throw new Error(`the nav, sidebar or home page links to ${link}, which is not a page of the site`);
  }
}

/**
 * The site's pages that the packages link to (their READMEs, package.json homepage and
 * --help) must exist: the links are in what users install, so a renamed page would break
 * them silently.
 */
function checkSiteLinks(): void {
  const site = `https://rayanyedaly.github.io${BASE}`;
  const files = readdirSync(resolve(repoDir, "packages")).flatMap((p) =>
    ["README.md", "package.json", "src/cli.ts"].map((f) => resolve(repoDir, "packages", p, f)).filter((f) => existsSync(f)),
  );
  let checked = 0;
  for (const file of [resolve(repoDir, "README.md"), ...files]) {
    for (const [url] of readFileSync(file, "utf8").matchAll(new RegExp(`${site.replaceAll(".", "\\.")}[\\w./-]*`, "g"))) {
      // A sentence may end right after the link.
      const path = url.slice(site.length).replace(/[./]+$/, "");
      // Only page links: a file the build writes (llms.txt) has an extension.
      if (/\.\w+$/.test(path)) continue;
      checked++;
      const pages = path === "" ? ["index.md"] : [`${path}.md`, `${path}/index.md`];
      if (!pages.some((page) => existsSync(resolve(docsDir, page))))
        throw new Error(`${relative(repoDir, file)}: ${url} is not a page of the site (no ${pages.map((p) => `docs/${p}`).join(" or ")})`);
    }
  }
  // The README links to the site, so finding none means this check is looking in the wrong place.
  if (checked === 0) throw new Error(`no link to ${site} found in the README or the packages`);
}

checkSiteLinks();

/** The Markdown copy a relative link to a page points at: cli.md#lint is /samesight/cli.md#lint. */
function copyHref(href: string, page: string): string | undefined {
  const link = relativeLink(href, page);
  if (!link) return undefined;
  let path = relative(docsDir, link.target).split(sep).join("/");
  if (existsSync(link.target) && statSync(link.target).isDirectory()) path = path ? `${path}/index.md` : "index.md";
  if (!path.endsWith(".md")) return undefined;
  // The home page has no Markdown copy; another folder's index.md is copied as the folder's name.
  if (path === "index.md") return `${BASE}${link.rest}`;
  return `${BASE}${encodeURI(path.replace(/\/index\.md$/, ".md"))}${link.rest}`;
}

export default defineConfig({
  title: "Samesight",
  description: "Catches PowerSync sync configs that send devices rows your database refuses",
  base: BASE,
  cleanUrls: true,
  lastUpdated: false,
  markdown: {
    config: repoLinks,
  },
  vite: {
    // llms.txt, llms-full.txt and a Markdown copy of each page, for coding agents. Each page
    // links to llms.txt in its head; no hidden note on the home page.
    plugins: [llmstxt({ injectLLMHint: false })],
  },
  buildEnd: (site) => {
    checkThemeLinks(site.outDir, site.site.themeConfig);
    llmsLinks(site.outDir);
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/how-sync-configs-leak" },
      // The rules' own pages when they are there, else their section of the CLI page.
      { text: "Lint rules", link: hasRulesIndex ? "/rules/" : "/cli#lint", activeMatch: "^/rules/" },
      { text: "CLI", link: "/cli" },
      { text: "CI", link: "/ci" },
      { text: "Changelog", link: `${REPO}/blob/main/CHANGELOG.md` },
      { text: "npm", link: "https://www.npmjs.com/package/samesight" },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Why I built this", link: "/why" },
          { text: "How sync configs leak", link: "/how-sync-configs-leak" },
          { text: "Getting started with a policy", link: "/getting-started" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Audit and the verifier", link: "/verify" },
          { text: "CLI", link: "/cli" },
          { text: "Policy language", link: "/policy" },
          { text: "CI and the GitHub Action", link: "/ci" },
        ],
      },
      ...(ruleItems.length > 0 ? [{ text: "Lint rules", items: ruleItems }] : []),
    ],
    outline: { level: [2, 3] },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: REPO }],
    editLink: {
      pattern: `${REPO}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
    footer: { message: "MIT licensed" },
  },
});
