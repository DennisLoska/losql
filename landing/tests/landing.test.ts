import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";

const ROOT = join(import.meta.dir, "..", "..");
const BUILD_SCRIPT = join(ROOT, "landing", "build.mjs");

// A deliberately small DOM for this page's progressive enhancement script. Elements,
// attributes and text come from the built HTML, never a hand-authored page fixture.
function createPageDOM(html: string) {
  type Event = {
    type: string;
    key?: string;
    target?: Element;
    defaultPrevented?: boolean;
    preventDefault(): void;
  };
  const decode = (text: string) => text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, name: string) => {
    if (name.startsWith("#")) return String.fromCodePoint(name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as Record<string, string>)[name] ?? entity;
  });
  const dataAttribute = (key: string) => `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  let activeElement: Element | null = null;

  class Element {
    attributes = new Map<string, string>();
    children: (Element | string)[] = [];
    parent: Element | null = null;
    listeners = new Map<string, ((event: Event) => unknown)[]>();
    dataset = new Proxy({} as Record<string, string>, {
      get: (_, key: string) => this.getAttribute(dataAttribute(key)) ?? undefined,
      set: (_, key: string, value: string) => { this.setAttribute(dataAttribute(key), value); return true; },
      deleteProperty: (_, key: string) => { this.removeAttribute(dataAttribute(key)); return true; },
      ownKeys: () => [...this.attributes.keys()].filter((key) => key.startsWith("data-")).map((key) => key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())),
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
    });
    constructor(readonly tag: string) {}
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    get id() { return this.getAttribute("id") ?? ""; }
    get tabIndex() { return Number(this.getAttribute("tabindex") ?? (this.tag === "button" ? 0 : -1)); }
    set tabIndex(value: number) { this.setAttribute("tabindex", String(value)); }
    get hidden() { return this.attributes.has("hidden"); }
    set hidden(value: boolean) { if (value) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
    get open() { return this.attributes.has("open"); }
    get src() { return this.getAttribute("src") ? new URL(this.getAttribute("src")!, "https://losql.dev/").href : ""; }
    set src(value: string) { this.setAttribute("src", value); }
    get currentSrc() { return this.src; }
    get alt() { return this.getAttribute("alt") ?? ""; }
    set alt(value: string) { this.setAttribute("alt", value); }
    get textContent(): string { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
    set textContent(value: string) { this.children = [value]; }
    matches(selector: string): boolean {
      const match = selector.match(/^([a-z][\w-]*)?(?:#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\])?$/i);
      if (!match || !match[0]) throw new Error(`Unsupported DOM selector: ${selector}`);
      const [, tag, id, className, attribute, value] = match;
      return (!tag || this.tag === tag) && (!id || this.id === id)
        && (!className || (this.getAttribute("class") ?? "").split(/\s+/).includes(className))
        && (!attribute || (value === undefined ? this.attributes.has(attribute) : this.getAttribute(attribute) === value));
    }
    querySelectorAll(selector: string): Element[] {
      const parts = selector.trim().split(/\s+/);
      const matches = (element: Element) => {
        if (!element.matches(parts.at(-1)!)) return false;
        let ancestor = element.parent;
        for (let i = parts.length - 2; i >= 0; i--) {
          while (ancestor && !ancestor.matches(parts[i]!)) ancestor = ancestor.parent;
          if (!ancestor) return false;
          ancestor = ancestor.parent;
        }
        return true;
      };
      const result: Element[] = [];
      const visit = (node: Element) => {
        for (const child of node.children) if (child instanceof Element) {
          if (matches(child)) result.push(child);
          visit(child);
        }
      };
      visit(this);
      return result;
    }
    querySelector(selector: string): Element {
      const element = this.querySelectorAll(selector)[0];
      if (!element) throw new Error(`Missing DOM element: ${selector}`);
      return element;
    }
    addEventListener(type: string, listener: (event: Event) => unknown) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    dispatchEvent(event: Event) {
      event.target ??= this;
      for (let node: Element | null = this; node; node = node.parent) {
        for (const listener of node.listeners.get(event.type) ?? []) listener(event);
      }
      return !event.defaultPrevented;
    }
    fire(type: string, key?: string) {
      return this.dispatchEvent({ type, key, preventDefault() { this.defaultPrevented = true; } });
    }
    focus() { activeElement = this; }
    click() {
      if (!this.fire("click")) return;
      // Native form submission in a method=dialog form closes its containing dialog.
      if (this.tag === "button") {
        let form = this.parent;
        while (form && form.tag !== "form") form = form.parent;
        if (form?.getAttribute("method") === "dialog") {
          let dialog = form.parent;
          while (dialog && dialog.tag !== "dialog") dialog = dialog.parent;
          dialog?.close();
        }
      }
    }
    keydown(key: string) {
      if (this.fire("keydown", key) && key === "Escape") {
        // Escape's native default action requests cancellation of a modal dialog.
        const dialog = document.querySelectorAll("dialog").find((item) => item.open);
        if (dialog?.fire("cancel")) dialog.close();
      }
    }
    showModal() { this.setAttribute("open", ""); }
    close() { this.removeAttribute("open"); this.fire("close"); }
  }

  const document = new Element("document");
  const stack = [document];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const tokens = html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+/gi) ?? [];
  for (const token of tokens) {
    if (token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      const tag = token.slice(2, -1).trim().toLowerCase();
      if (stack.at(-1)?.tag !== tag) throw new Error(`Unbalanced HTML closing tag: ${tag}`);
      stack.pop();
    } else if (token.startsWith("<")) {
      const [, tag, attributes] = token.match(/^<([\w-]+)([\s\S]*?)\/?\s*>$/)!;
      const element = new Element(tag!.toLowerCase());
      for (const match of attributes!.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        element.setAttribute(match[1]!.toLowerCase(), decode(match[2] ?? match[3] ?? match[4] ?? ""));
      }
      element.parent = stack.at(-1)!;
      element.parent.children.push(element);
      if (!voidTags.has(element.tag) && !token.endsWith("/>")) stack.push(element);
    } else stack.at(-1)!.children.push(decode(token));
  }
  if (stack.length !== 1) throw new Error("Unclosed HTML elements");
  return {
    document: Object.assign(document, {
      getElementById(id: string) { return document.querySelector(`#${id}`); },
    }),
    get activeElement() { return activeElement; },
  };
}

describe("landing/build.mjs and page content", () => {
  test("built page runs interactive site.js behavior in a deterministic DOM", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "losql-landing-smoke-"));
    try {
      const build = spawnSync("node", [BUILD_SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, LANDING_OUT: outDir },
        encoding: "utf8",
      });
      expect(build.status).toBe(0);
      const page = createPageDOM(readFileSync(join(outDir, "index.html"), "utf8"));
      const { document } = page;
      const copied: string[] = [];
      const timers: { callback: () => void; delay: number }[] = [];
      const motionPreference = { matches: false, addEventListener() {} };
      runInNewContext(readFileSync(join(outDir, "assets/site.js"), "utf8"), {
        document,
        navigator: { clipboard: { async writeText(text: string) { copied.push(text); } } },
        window: {
          matchMedia: () => motionPreference,
          setTimeout(callback: () => void, delay: number) { timers.push({ callback, delay }); return timers.length; },
        },
      }, { filename: "built/assets/site.js", timeout: 1000 });

      const groups = document.querySelectorAll("[data-tabs]");
      const required = ["Recorded workflows", "Product tour stops", "Omarchy and Theme previews", "Headless commands"];
      for (const label of required) {
        const group = groups.find((item) => item.querySelector('[role="tablist"]').getAttribute("aria-label") === label);
        expect(group).toBeDefined();
        const tabs = group!.querySelectorAll('[role="tab"]');
        expect(tabs.length).toBeGreaterThan(1);
        const check = (selected: number) => {
          for (const [index, tab] of tabs.entries()) {
            expect(tab.getAttribute("aria-selected")).toBe(String(index === selected));
            expect(tab.tabIndex).toBe(index === selected ? 0 : -1);
            expect(document.getElementById(tab.getAttribute("aria-controls")!).hidden).toBe(index !== selected);
          }
        };
        check(0);
        // Visit every tab in both directions, including wraparound at both ends.
        for (let index = 0; index < tabs.length; index++) {
          tabs[index]!.keydown("ArrowRight");
          check((index + 1) % tabs.length);
          expect(page.activeElement).toBe(tabs[(index + 1) % tabs.length]);
        }
        for (let index = 0; index < tabs.length; index++) {
          const current = (tabs.length - index) % tabs.length;
          const next = (current - 1 + tabs.length) % tabs.length;
          tabs[current]!.keydown("ArrowLeft");
          check(next);
          expect(page.activeElement).toBe(tabs[next]);
        }
        tabs[0]!.keydown("End");
        check(tabs.length - 1);
        expect(page.activeElement).toBe(tabs.at(-1)!);
        tabs.at(-1)!.keydown("Home");
        check(0);
        expect(page.activeElement).toBe(tabs[0]);
      }

      const staticTab = document.getElementById("hero-mode-tab-0");
      const liveTab = document.getElementById("hero-mode-tab-1");
      const staticImage = document.querySelector("#hero-mode-panel-0 img");
      const liveImage = document.querySelector("#hero-mode-panel-1 img");
      const gifImage = document.querySelector("#hero-mode-panel-2 img");
      liveTab.click();
      expect(liveTab.getAttribute("aria-selected")).toBe("true");
      expect(staticTab.getAttribute("aria-selected")).toBe("false");
      expect(document.getElementById("hero-mode-panel-1").hidden).toBe(false);
      expect(document.getElementById("hero-mode-panel-0").hidden).toBe(true);
      expect(liveImage.getAttribute("src")).toBe("/media/workflow-tour.webp");
      expect(gifImage.getAttribute("src")).toBe("/media/workflow-tour.gif");
      staticTab.click();
      expect(staticTab.getAttribute("aria-selected")).toBe("true");
      expect(liveTab.getAttribute("aria-selected")).toBe("false");
      expect(document.getElementById("hero-mode-panel-0").hidden).toBe(false);
      expect(document.getElementById("hero-mode-panel-1").hidden).toBe(true);
      expect(staticImage.getAttribute("src")).toBe("/media/hero.webp");

      const motion = document.querySelector(".motion-toggle");
      const recordings = document.querySelectorAll("img[data-static]");
      expect(recordings.length).toBeGreaterThan(0);
      expect(motion.getAttribute("aria-pressed")).toBe("true");
      motion.click();
      expect(motion.getAttribute("aria-pressed")).toBe("false");
      for (const image of recordings) expect(image.getAttribute("src")).toBe(image.dataset.static);
      motion.click();
      expect(motion.getAttribute("aria-pressed")).toBe("true");
      for (const image of recordings) expect(image.getAttribute("src")).toBe(image.dataset.fixedAnimation || image.dataset.webp);

      const gif = document.querySelector('[data-format="gif"]');
      const webp = document.querySelector('[data-format="webp"]');
      for (const [format, selected, other] of [["gif", gif, webp], ["webp", webp, gif]] as const) {
        selected.click();
        expect(selected.getAttribute("aria-pressed")).toBe("true");
        expect(other.getAttribute("aria-pressed")).toBe("false");
        for (const image of recordings) {
          expect(image.getAttribute("src")).toBe(image.dataset.fixedAnimation || image.dataset[format]);
          if (!image.dataset.fixedAnimation) expect(image.getAttribute("src")).toEndWith(`.${format}`);
        }
      }

      const copy = document.querySelector("[data-copy]");
      const command = document.getElementById(copy.dataset.copy!).textContent;
      expect(command).toBe('losql exec -c demo "select count(*) from orders"');
      copy.click();
      await Promise.resolve();
      expect(copied).toEqual([command]);
      expect(copy.dataset.copied).toBe("true");
      expect(document.getElementById("copy-status").textContent).toBe("Command copied to clipboard.");
      expect(timers).toHaveLength(1);
      expect(timers[0]!.delay).toBe(2500);
      timers[0]!.callback();
      expect(copy.dataset.copied).toBeUndefined();
      expect(copy.textContent).toBe("Copy");

      const dialog = document.getElementById("lightbox");
      const enlarged = document.querySelector("#lightbox img");
      const trigger = document.querySelector(".zoomable");
      const image = trigger.querySelector("img");
      expect(dialog.open).toBe(false);
      for (const close of [() => dialog.keydown("Escape"), () => dialog.querySelector("button").click()]) {
        trigger.click();
        expect(dialog.open).toBe(true);
        expect(enlarged.src).toBe(image.src);
        expect(enlarged.alt).toBe(image.alt);
        expect(enlarged.alt.length).toBeGreaterThan(0);
        close();
        expect(dialog.open).toBe(false);
        expect(enlarged.getAttribute("src")).toBeNull();
      }
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
