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
    const servedFile = !exists || statSync(target).isDirectory() || /\.(md|html)$/.test(target);
    if (servedFile || isInside(resolve(docsDir, "public"), target)) return undefined;
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
        return line.replace(/\]\(([^)\s]+)\)/g, (whole, href: string) => {
          const url = siteHref(href, page) ?? copyHref(href, page);
          return url ? `](${url})` : whole;
        });
      });
    writeFileSync(join(outDir, file), lines.join("\n"));
  }
}

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
    // llms.txt, llms-full.txt and a Markdown copy of each page, for coding agents.
    plugins: [llmstxt()],
  },
  buildEnd: (site) => llmsLinks(site.outDir),
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
