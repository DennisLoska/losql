import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.env.LANDING_OUT || path.join(ROOT, "dist"));
const staticMedia = ["hero", "editor", "agent", "json", "record", "zoom", "providers", "themes", "menu", "onboarding", "omarchy", "omarchy-transparent"];
const recordings = ["workflow-tour", "recording-vim", "recording-agent", "recording-omarchy"];
const required = [
  "src/index.html", "src/404.html", "src/site.css", "src/site.js", "public/favicon.svg",
  "public/fonts/PlusJakartaSans-latin.woff2", "public/fonts/JetBrainsMono-latin.woff2",
  "public/fonts/OFL-PlusJakartaSans.txt", "public/fonts/OFL-JetBrainsMono.txt", "public/media/manifest.json",
  ...staticMedia.map((name) => `public/media/${name}.webp`),
  ...recordings.flatMap((name) => ["webp", "gif"].map((format) => `public/media/${name}.${format}`)),
];
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};
// Resolve existing ancestors too, so an output path through a symlink cannot erase sources.
function canonical(destination) {
  if (existsSync(destination)) return realpathSync(destination);
  return path.join(canonical(path.dirname(destination)), path.basename(destination));
}
const output = canonical(OUT);
const root = realpathSync(ROOT);
if (within(output, root) || ["src", "public", "tests", "scripts"].some((dir) => within(path.join(root, dir), output))) {
  throw new Error(`Unsafe LANDING_OUT: ${OUT}`);
}
for (const file of required) {
  const source = path.join(ROOT, file);
  if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
    throw new Error(`Missing or empty landing source: ${file}`);
  }
}
function validateTree(directory) {
  for (const name of readdirSync(directory)) {
    const source = path.join(directory, name);
    const info = lstatSync(source);
    if (info.isSymbolicLink()) throw new Error(`Landing sources must not be symlinks: ${source}`);
    if (info.isDirectory()) validateTree(source);
    else if (!info.isFile() || info.size === 0) throw new Error(`Invalid landing source: ${source}`);
  }
}
validateTree(path.join(ROOT, "src"));
validateTree(path.join(ROOT, "public"));
// Validate everything before removing an earlier build.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, "assets"), { recursive: true });
for (const name of ["index.html", "404.html"]) cpSync(path.join(ROOT, "src", name), path.join(OUT, name));
for (const name of ["site.css", "site.js"]) cpSync(path.join(ROOT, "src", name), path.join(OUT, "assets", name));
for (const name of ["favicon.svg", "fonts", "media"]) cpSync(path.join(ROOT, "public", name), path.join(OUT, name), { recursive: true });
writeFileSync(path.join(OUT, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://losql.dev/sitemap.xml\n");
writeFileSync(
  path.join(OUT, "sitemap.xml"),
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    "  <url>",
    "    <loc>https://losql.dev/</loc>",
    "    <changefreq>weekly</changefreq>",
    "    <priority>1.0</priority>",
    "    <image:image><image:loc>https://losql.dev/media/hero.webp</image:loc><image:title>losql terminal SQL workspace</image:title></image:image>",
    "    <image:image><image:loc>https://losql.dev/media/editor.webp</image:loc><image:title>Modal Vim SQL editing and schema completion in losql</image:title></image:image>",
    "    <image:image><image:loc>https://losql.dev/media/agent.webp</image:loc><image:title>Read-only AI Agent steps and SQL proposals in losql</image:title></image:image>",
    "    <image:image><image:loc>https://losql.dev/media/omarchy.webp</image:loc><image:title>losql in the live Omarchy system palette</image:title></image:image>",
    "    <image:image><image:loc>https://losql.dev/media/omarchy-transparent.webp</image:loc><image:title>losql with transparent pane backgrounds</image:title></image:image>",
    "  </url>",
    "</urlset>",
    "",
  ].join("\n"),
);
writeFileSync(
  path.join(OUT, "llms.txt"),
  [
    "# losql",
    "",
    "> Write the query yourself, or ask for it. A vim-first SQL client for the terminal, with an agent on board. SQLite and PostgreSQL in one compiled binary, no API keys, Omarchy first.",
    "",
    "- Website: https://losql.dev/",
    "- Repository: https://github.com/DennisLoska/losql",
    "- License: MIT",
    "",
    "## Highlights",
    "- Modal Vim SQL editing (`is`/`as` statement text objects, operators, registers, dot repeat, `/` regex search, `ctrl+n` live schema completion).",
    "- Agent on board with zero API keys: drives local coding CLIs (`claude`, `codex`, `opencode`, `antigravity`) in an isolated read-only directory with database credentials stripped.",
    "- In-process SQLite (`bun:sqlite`) and PostgreSQL driver in a single compiled binary (`losql demo`, `losql ./app.db`, `losql postgres://...`).",
    "- Three instant Result views (`Table`, `JSON`, `Record`) plus full-screen zoom (`space z`).",
    "- First-class Omarchy live `colors.toml` theme synchronization, `:set transparent` / `ctrl+t` transparent pane mode, and 7 built-in OpenCode-format themes.",
    "- Scriptable headless CLI: `losql exec`, `losql ask`, and `losql providers --test`.",
    "",
  ].join("\n"),
);
writeFileSync(
  path.join(OUT, "site.webmanifest"),
  JSON.stringify(
    {
      name: "losql",
      short_name: "losql",
      description: "A vim-first SQL client for the terminal, with an agent on board. SQLite and PostgreSQL in one binary, no API keys.",
      start_url: "/",
      display: "standalone",
      background_color: "#000000",
      theme_color: "#000000",
      icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }],
    },
    null,
    2,
  ) + "\n",
);
console.log(`Built losql.dev → ${OUT}`);

