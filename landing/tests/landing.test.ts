import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..", "..");
const BUILD_SCRIPT = join(ROOT, "landing", "build.mjs");

describe("landing/build.mjs and page content", () => {
  test("CLI panels render captured binary stdout and stderr", () => {
    const outDir = mkdtempSync(join(tmpdir(), "losql-cli-output-"));
    try {
      const build = spawnSync("node", [BUILD_SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, LANDING_OUT: outDir },
        encoding: "utf8",
      });
      expect(build.status).toBe(0);
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const captures = [
        {
          "panel": 0,
          "stdout": " count(*) \n----------\n       12 \n(1 row)\n",
          "stderr": ""
        },
        {
          "panel": 1,
          "stdout": "select c.name, c.country,\n       round(sum(i.quantity * i.unit_price), 2)\n         as revenue\nfrom customers c\njoin orders o on o.customer_id = c.id\njoin order_items i on i.order_id = o.id\ngroup by c.id\norder by revenue desc;\n name              | country | revenue \n-------------------+---------+---------\n Ada Lovelace      | UK      |     342 \n Barbara Liskov    | US      |     310 \n Alan Turing       | UK      |   238.5 \n Margaret Hamilton | US      |     214 \n Ken Thompson      | US      |     194 \n Grace Hopper      | US      |   185.5 \n Linus Torvalds    | FI      |   182.5 \n Edsger Dijkstra   | NL      |     168 \n(8 rows)\n",
          "stderr": "losql: describe customers, orders, order_items\nlosql: query select c.name, count(o.id) as orders from customers c join orders o on o.customer_id = c.id group by c.id\nRevenue by customer, verified against the demo database. Ada leads with multiple orders. Review the SQL before running.\n"
        },
        {
          "panel": 2,
          "stdout": "Claude Code  1.0.0  /tmp/losql-cli-uIQQHv/bin/claude  replied in 0.0s\nCodex  1.0.0  /tmp/losql-cli-uIQQHv/bin/codex  replied in 0.0s\nOpenCode  1.0.0  /tmp/losql-cli-uIQQHv/bin/opencode  replied in 0.0s\nAntigravity  1.0.0  /tmp/losql-cli-uIQQHv/bin/antigravity  replied in 0.0s\n",
          "stderr": ""
        }
      ];
      for (const { panel, stdout, stderr } of captures) {
        const content = html.match(new RegExp(`<div role="tabpanel" id="cli-command-panel-${panel}"[\\s\\S]*?(?=<div role="tabpanel"|</section>)`))?.[0];
        expect(content).toBeDefined();
        for (const [stream, output] of [["stdout", stdout], ["stderr", stderr]]) {
          if (!output) continue;
          const escaped = output.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
          expect(content).toContain(`<pre aria-label="${stream}"><code>${escaped}</code></pre>`);
        }
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("build.mjs uses only Node standard library imports and builds into LANDING_OUT from any cwd", () => {
    const buildSource = readFileSync(BUILD_SCRIPT, "utf8");
    const imports = [...buildSource.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(["node:fs", "node:path", "node:url"]).toContain(spec);
    }

    const outDir = mkdtempSync(join(tmpdir(), "losql-landing-out-"));
    try {
      const res = spawnSync("node", [BUILD_SCRIPT], {
        cwd: tmpdir(),
        env: { ...process.env, LANDING_OUT: outDir },
        encoding: "utf8",
      });
      expect(res.status).toBe(0);

      for (const file of [
        "index.html",
        "404.html",
        "robots.txt",
        "sitemap.xml",
        "favicon.svg",
        "assets/site.css",
        "assets/site.js",
        "fonts/PlusJakartaSans-latin.woff2",
        "fonts/JetBrainsMono-latin.woff2",
        "media/hero.webp",
        "media/omarchy.webp",
        "media/omarchy-transparent.webp",
        "media/workflow-tour.webp",
        "media/workflow-tour.gif",
        "media/recording-vim.webp",
        "media/recording-vim.gif",
        "media/recording-agent.webp",
        "media/recording-agent.gif",
        "media/recording-omarchy.webp",
        "media/recording-omarchy.gif",
        "media/manifest.json",
      ]) {
        expect(existsSync(join(outDir, file))).toBe(true);
      }

      const indexHtml = readFileSync(join(outDir, "index.html"), "utf8");
      const notFoundHtml = readFileSync(join(outDir, "404.html"), "utf8");

      // Positioning & Glossary terms
      expect(indexHtml).toContain("Write the query yourself, or ask for it.");
      expect(indexHtml).toContain("vim-first SQL client for the terminal");
      expect(indexHtml).toContain("SQLite");
      expect(indexHtml).toContain("Postgres");
      expect(indexHtml).toContain("Schema");
      expect(indexHtml).toContain("Buffer");
      expect(indexHtml).toContain("Statement");
      expect(indexHtml).toContain("Result view");
      expect(indexHtml).toContain("Proposal");
      expect(indexHtml).toContain("Provider");
      expect(indexHtml).toContain("Transparent");

      // Required inspirations & credits links
      expect(indexHtml).toContain("https://neovim.io");
      expect(indexHtml).toContain("https://opencode.ai");
      expect(indexHtml).toContain("https://github.com/sst/opencode");
      expect(indexHtml).toContain("https://omarchy.org");
      expect(indexHtml).toContain("https://harlequin.sh");
      expect(indexHtml).toContain("https://github.com/jorgerojas26/lazysql");
      expect(indexHtml).toContain("https://github.com/anomalyco/opentui");
      expect(indexHtml).toContain("https://bun.sh");
      expect(indexHtml).toContain("https://github.com/DennisLoska/losql");

      // Omarchy first-class showcase
      expect(indexHtml).toContain("colors.toml");
      expect(indexHtml).toContain("omarchy-transparent.webp");
      expect(indexHtml).toContain(":set transparent");

      // All 9 Tour stops & 3 Animated recordings
      for (const media of [
        "hero.webp",
        "editor.webp",
        "agent.webp",
        "json.webp",
        "record.webp",
        "zoom.webp",
        "providers.webp",
        "themes.webp",
        "menu.webp",
        "recording-vim.webp",
        "recording-vim.gif",
        "recording-agent.webp",
        "recording-agent.gif",
        "recording-omarchy.webp",
        "recording-omarchy.gif",
      ]) {
        expect(indexHtml).toContain(media);
      }

      // Strict negative guards: no fake content, no fork/steal encouragement, no star counters, no external Google Fonts
      expect(indexHtml.toLowerCase()).not.toContain("steal our code");
      expect(indexHtml.toLowerCase()).not.toContain("fork it");
      expect(indexHtml.toLowerCase()).not.toContain("fork on github");
      expect(indexHtml).not.toContain("/fork");
      expect(indexHtml.toLowerCase()).not.toContain("github stars");
      expect(indexHtml.toLowerCase()).not.toContain("tweeted about it");
      expect(indexHtml.toLowerCase()).not.toContain("fonts.googleapis.com");
      expect(notFoundHtml).toContain("404");
      expect(notFoundHtml).toContain("losql");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("built pages have valid local links and anchors, and README links to the site", () => {
    const outDir = mkdtempSync(join(tmpdir(), "losql-landing-links-"));
    try {
      const build = spawnSync("node", [BUILD_SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, LANDING_OUT: outDir },
        encoding: "utf8",
      });
      expect(build.status).toBe(0);

      const pages = ["index.html", "404.html"];
      const pageContents = new Map(pages.map((page) => [page, readFileSync(join(outDir, page), "utf8")]));
      for (const [page, html] of pageContents) {
        const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
        for (const match of html.matchAll(/\b(?:src|href)=["']([^"']*)["']/g)) {
          const attr = match[1];
          if (attr.startsWith("#")) {
            expect(ids.has(attr.slice(1))).toBe(true);
            continue;
          }
          if (/^(?:https?:\/\/|mailto:|data:)/.test(attr)) continue;

          const localPath = attr.split(/[?#]/, 1)[0];
          const outputPath = localPath === "/" ? "index.html" : localPath.startsWith("/")
            ? localPath.slice(1)
            : join(dirname(page), localPath);
          const resolvedPath = resolve(outDir, outputPath);
          expect(existsSync(resolvedPath) && statSync(resolvedPath).isFile()).toBe(true);
        }
      }

      expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain("https://losql.dev");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
