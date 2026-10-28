#!/usr/bin/env node
/**
 * Renders the audit transcript in docs/assets/audit-demo.txt (written by
 * scripts/demo/capture.sh; its first line is the command, after "$ ") as a terminal window,
 * in two SVGs: docs/assets/audit-demo-light.svg and docs/assets/audit-demo-dark.svg.
 *
 * Colours follow samesight-verify's own colour mode: the ok, warn and FAIL marks green,
 * yellow and red, the labels of a row block dim, the summary line by its result. The run
 * kind of a row block (leak:) is red too, and section titles bold. Lines longer than COLS
 * wrap at a space; a command wraps with a trailing backslash, so it still reads as one.
 *
 *   node scripts/demo/render.mjs           write both SVGs
 *   node scripts/demo/render.mjs --check   exit 1 if either differs from a fresh render
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ASSETS = "docs/assets";
const SOURCE = `${ASSETS}/audit-demo.txt`;
const TITLE = "examples/audit-todolist";
const COLS = 108;

const FONT_SIZE = 13;
/** A monospace advance is about 0.6em; a little over, so no font overflows the window. */
const CHAR = 7.9;
const LINE = 19;
const PAD = 20;
const BAR = 34;

const PALETTES = {
  light: { bg: "#ffffff", bar: "#f6f8fa", border: "#d1d9e0", text: "#1f2328", dim: "#59636e", red: "#c4161c", green: "#116329", yellow: "#7a4d00", accent: "#0550ae" },
  dark: { bg: "#0d1117", bar: "#161b22", border: "#3d444d", text: "#e6edf3", dim: "#9198a1", red: "#ff7b72", green: "#56d364", yellow: "#e3b341", accent: "#79c0ff" },
};
/** The window's three dots: decoration, not text. */
const DOTS = ["#ff5f57", "#febc2e", "#28c840"];

const args = process.argv.slice(2);
const check = args.includes("--check");
if (args.some((a) => a !== "--check")) {
  console.error("Usage: node scripts/demo/render.mjs [--check]");
  process.exit(2);
}

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A line's pieces, each with a class or none, by the rules of the CLI's colour mode. */
function classify(line, first) {
  if (first) return [["accent", "$"], [null, line.slice(1)]];
  let m = /^(ok|warn|FAIL)(\s.*)$/.exec(line);
  if (m) return [[{ ok: "green", warn: "yellow", FAIL: "red" }[m[1]], m[1]], [null, m[2]]];
  m = /^(FAILED|PASSED|INCOMPLETE)(:[^,(]*)?(.*)$/.exec(line);
  if (m) return [[`${{ FAILED: "red", PASSED: "green", INCOMPLETE: "yellow" }[m[1]]} b`, m[1] + (m[2] ?? "")], [null, m[3]]];
  m = /^(\s+)(leak|hidden|gap|unsent|differs)(:.*)$/.exec(line);
  if (m) return [[null, m[1]], ["red", m[2]], [null, m[3]]];
  m = /^(\s+)(sent by|refused by|allowed by|policies|likely fix|replay)(\s.*)$/.exec(line);
  if (m) return [[null, m[1]], ["dim", m[2]], [null, m[3]]];
  if (/^\s*\(.*\)$/.test(line)) return [["dim", line]];
  if (/^[A-Z]/.test(line)) return [["b", line]];
  return [[null, line]];
}

/** Splits a long line at spaces: a command keeps a trailing backslash on each broken line. */
function wrap(line, first) {
  if (line.length <= COLS) return [line];
  const command = first || /^\s+replay\s/.test(line);
  const indent = first ? "    " : command ? " ".repeat(line.search(/\S/) + 11) : `${line.match(/^\s*/)[0]}      `;
  const words = line.trimStart().split(" ");
  const out = [];
  let current = line.match(/^\s*/)[0] + words.shift();
  for (const w of words) {
    if (`${current} ${w}`.length > COLS - (command ? 2 : 0)) {
      out.push(command ? `${current} \\` : current);
      current = indent + w;
    } else current += ` ${w}`;
  }
  out.push(current);
  return out;
}

function render(text, theme) {
  const p = PALETTES[theme];
  const source = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  if (!source[0]?.startsWith("$ ")) throw new Error(`${SOURCE} must start with the command, after "$ "`);
  const command = source[0].slice(2);
  // Each wrapped piece keeps the classes of its line's start only, so continuations are plain.
  const lines = source.flatMap((line, i) => wrap(line, i === 0).map((piece, j) => (j === 0 ? classify(piece, i === 0) : [[null, piece]])));
  const cols = Math.max(...source.flatMap((l, i) => wrap(l, i === 0)).map((l) => [...l].length));
  const width = Math.ceil(PAD * 2 + cols * CHAR);
  const height = BAR + PAD + lines.length * LINE + PAD - 4;
  const summary = source.findLast((l) => /^(FAILED|PASSED|INCOMPLETE)/.test(l)) ?? "";
  const label = `Terminal output of ${command}: audit reports devices holding rows RLS refuses their users. ${summary}`;

  const body = lines
    .map((pieces, i) => {
      const y = BAR + PAD + 10 + i * LINE;
      const spans = pieces
        .filter(([, s]) => s.length)
        .map(([cls, s]) => (cls ? `<tspan class="${cls}">${xml(s)}</tspan>` : xml(s)))
        .join("");
      return spans ? `<text x="${PAD}" y="${y}" xml:space="preserve">${spans}</text>` : "";
    })
    .filter(Boolean);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(label)}">`,
    `<title>${xml(`samesight audit catching a planted sync config leak (${theme})`)}</title>`,
    `<desc>${xml(source.join("\n"))}</desc>`,
    "<style>",
    `text{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono','DejaVu Sans Mono',monospace;font-size:${FONT_SIZE}px;fill:${p.text};white-space:pre}`,
    `.b{font-weight:bold}.dim{fill:${p.dim}}.red{fill:${p.red}}.green{fill:${p.green}}.yellow{fill:${p.yellow}}.accent{fill:${p.accent}}`,
    "</style>",
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${p.bg}" stroke="${p.border}"/>`,
    `<path d="M0.5 ${BAR}V10.5a10 10 0 0 1 10-10H${width - 10.5}a10 10 0 0 1 10 10V${BAR}Z" fill="${p.bar}" stroke="${p.border}"/>`,
    ...DOTS.map((c, i) => `<circle cx="${20 + i * 20}" cy="${BAR / 2}" r="6" fill="${c}"/>`),
    `<text x="${width / 2}" y="${BAR / 2 + 4}" text-anchor="middle" class="dim">${xml(TITLE)}</text>`,
    ...body,
    "</svg>",
    "",
  ].join("\n");
}

/**
 * The transcript as plain text: colour codes (from a run saved without NO_COLOR) are dropped,
 * and any other control character, which XML cannot hold, stops the render.
 */
function plain(raw) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes start with ESC
  const text = raw.replace(/\r\n/g, "\n").replace(/\x1b\[[0-9;]*m/g, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for
  const bad = /[\x00-\x08\x0b-\x1f\x7f]/.exec(text);
  if (bad) {
    const line = text.slice(0, bad.index).split("\n").length;
    console.error(`render.mjs: ${SOURCE} line ${line} holds control character U+${bad[0].charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}, which an SVG cannot hold; capture the run again with NO_COLOR=1`);
    process.exit(2);
  }
  return text;
}

const text = plain(readFileSync(join(ROOT, SOURCE), "utf8"));
let stale = 0;
for (const theme of Object.keys(PALETTES)) {
  const file = `${ASSETS}/audit-demo-${theme}.svg`;
  const svg = render(text, theme);
  if (check) {
    let onDisk = "";
    try {
      onDisk = readFileSync(join(ROOT, file), "utf8");
    } catch {}
    if (onDisk !== svg) {
      console.error(`${file} is not what ${SOURCE} renders to. Run: node scripts/demo/render.mjs`);
      stale++;
    }
  } else {
    writeFileSync(join(ROOT, file), svg);
    console.log(`wrote ${file} (${Buffer.byteLength(svg)} bytes)`);
  }
}
if (stale) process.exit(1);
if (check) console.log(`${ASSETS}/audit-demo-*.svg match ${SOURCE}`);
