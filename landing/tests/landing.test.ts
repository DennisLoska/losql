import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..", "..");
const BUILD_SCRIPT = join(ROOT, "landing", "build.mjs");

describe("landing/build.mjs and page content", () => {
  test("built page runs interactive site.js behavior in headless Chromium", async () => {
    const chromium = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]
      .map((binary) => spawnSync("which", [binary], { encoding: "utf8" }).stdout.trim())
      .find(Boolean);
    expect(chromium).not.toBeNull();

    const outDir = mkdtempSync(join(tmpdir(), "losql-landing-smoke-"));
    try {
      const build = spawnSync("node", [BUILD_SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, LANDING_OUT: outDir },
        encoding: "utf8",
      });
      expect(build.status).toBe(0);

      const indexPath = join(outDir, "index.html");
      // A file URL treats root-relative paths as filesystem-root paths. Rewrite only the
      // temporary build copy so the real built assets remain resolvable under file://.
      let html = readFileSync(indexPath, "utf8").replace(/([="'])\/(?!\/)/g, "$1");
      const probe = String.raw`<script>
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
window.addEventListener('load', async () => {
  const result = {};
  const groups = [...document.querySelectorAll('[data-tabs]')];
  const required = ['Recorded workflows', 'Product tour stops', 'Omarchy and Theme previews', 'Headless commands'];
  result.tabGroups = required.map((label) => {
    const group = groups.find((item) => item.querySelector('[role="tablist"]').getAttribute('aria-label') === label);
    if (!group) return { label, missing: true };
    const tabs = [...group.querySelectorAll('[role="tab"]')];
    const check = (index) => ({ selected: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').length === 1 && tabs[index].getAttribute('aria-selected') === 'true', tabIndex: tabs[index].tabIndex === 0 && tabs.every((tab, i) => i === index || tab.tabIndex === -1), panels: tabs.every((tab, i) => document.getElementById(tab.getAttribute('aria-controls')).hidden === (i !== index)) });
    const event = (index, key) => { tabs[index].dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); const target = key === 'End' ? tabs.length - 1 : key === 'Home' ? 0 : key === 'ArrowRight' ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length; return check(target); };
    return { label, right: event(0, 'ArrowRight'), left: event(1, 'ArrowLeft'), home: event(1, 'Home'), end: event(0, 'End') };
  });
  const heroTabs = [...document.querySelectorAll('[role="tab"]')].filter((tab) => tab.id.startsWith('hero-mode-tab-'));
  heroTabs[1].click();
  result.heroLive = { src: document.querySelector('#hero-mode-panel-1 img').getAttribute('src'), selected: heroTabs[1].getAttribute('aria-selected') };
  heroTabs[0].click();
  result.heroStatic = { src: document.querySelector('#hero-mode-panel-0 img').getAttribute('src'), selected: heroTabs[0].getAttribute('aria-selected') };
  document.querySelector('.motion-toggle').click();
  document.querySelector('.motion-toggle').click();
  document.querySelector('[data-format="gif"]').click();
  result.format = { selected: document.querySelector('[data-format="gif"]').getAttribute('aria-pressed'), gifs: [...document.querySelectorAll('img[data-static]')].filter((img) => img.getAttribute('src').endsWith('.gif')).length };
  const copyButton = document.querySelector('[data-copy]');
  const command = document.getElementById(copyButton.dataset.copy).textContent;
  copyButton.click();
  await Promise.resolve();
  await Promise.resolve();
  result.copy = { copied: window.__copied, command, copiedState: copyButton.dataset.copied };
  const trigger = document.querySelector('.zoomable');
  const selectedImage = trigger.querySelector('img');
  trigger.click();
  const dialog = document.getElementById('lightbox');
  result.lightboxOpen = { open: dialog.open, src: dialog.querySelector('img').getAttribute('src'), selected: selectedImage.getAttribute('src') };
  dialog.requestClose(); // the browser's native Escape close request for a modal dialog
  result.lightboxClosed = !dialog.open;
  document.title = 'SMOKE:' + btoa(JSON.stringify(result));
});
</script>`;
      html = html.replace("</body>", `${probe}</body>`);
      require("node:fs").writeFileSync(indexPath, html);

      const run = spawnSync(chromium!, [
        "--headless=new", "--no-sandbox", "--disable-gpu", `--user-data-dir=${join(outDir, "profile")}`,
        "--virtual-time-budget=3000", "--dump-dom", `file://${indexPath}`,
      ], { encoding: "utf8", timeout: 30_000 });
      expect(run.status).toBe(0);
      const encoded = run.stdout.match(/<title>SMOKE:([^<]+)<\/title>/)?.[1];
      expect(encoded).toBeDefined();
      const result = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));

      expect(result.tabGroups).toHaveLength(4);
      for (const group of result.tabGroups) {
        expect(group.missing).toBeUndefined();
        for (const key of ["right", "left", "home", "end"]) {
          expect(group[key]).toEqual({ selected: true, tabIndex: true, panels: true });
        }
      }
      expect(result.heroLive).toEqual({ src: "media/workflow-tour.webp", selected: "true" });
      expect(result.heroStatic).toEqual({ src: "media/hero.webp", selected: "true" });
      expect(result.format.selected).toBe("true");
      expect(result.format.gifs).toBeGreaterThan(0);
      expect(result.copy.copied).toBe(result.copy.command);
      expect(result.copy.copiedState).toBe("true");
      expect(result.lightboxOpen.open).toBe(true);
      expect(result.lightboxOpen.src).toEndWith(`/${result.lightboxOpen.selected}`);
      expect(result.lightboxClosed).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

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
