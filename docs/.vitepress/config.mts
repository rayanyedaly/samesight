import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type DefaultTheme, defineConfig, type MarkdownRenderer } from "vitepress";
import { RULE_INFO } from "../../packages/samesight/src/lint/rule-info.ts";

const REPO = "https://github.com/rayanyedaly/samesight";

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

/**
 * Where a relative link should point on the site. The docs link to the rest of the
 * repository with relative paths (../examples/fieldbook) so they work on GitHub; the site
 * only has docs/, so those links go to the file on GitHub instead. So do links to files in
 * docs/ that are not pages (assets/audit-demo.txt), which the build does not copy. Returns
 * undefined for links the site serves.
 */
function siteHref(href: string, page: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) return undefined;
  const cut = href.search(/[?#]/);
  const path = cut < 0 ? href : href.slice(0, cut);
  const rest = cut < 0 ? "" : href.slice(cut);
  const target = resolve(dirname(page), decodeURIComponent(path));
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

export default defineConfig({
  title: "Samesight",
  description: "Catches PowerSync sync configs that send devices rows your database refuses",
  base: "/samesight/",
  cleanUrls: true,
  lastUpdated: false,
  markdown: {
    config: repoLinks,
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
