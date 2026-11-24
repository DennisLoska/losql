import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";

const ROOT = join(import.meta.dir, "..", "..");
const BUILD_SCRIPT = join(ROOT, "landing", "build.mjs");
const MEDIA_DIR = join(ROOT, "landing", "public", "media");
// Content-hash cache busting: the first 8 hex chars of the media file's SHA-256.
const mediaHash = (name: string) => createHash("sha256").update(readFileSync(join(MEDIA_DIR, name))).digest("hex").slice(0, 8);
const mediaUrl = (name: string) => `/media/${name}?v=${mediaHash(name)}`;

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
  test("supporting text uses the desktop and mobile type scale", () => {
    const css = readFileSync(join(ROOT, "landing/src/site.css"), "utf8");
    const [desktop, mobile] = css.split("@media (max-width: 700px) {");
    expect(mobile).toBeDefined();
    for (const selector of [
      ".media-note", ".media-controls > span", ".footer-facts", ".footer-copy",
      "footer nav", ".install-grid p", ".credits-grid p",
    ]) {
      for (const [scope, size] of [[desktop!, "14px"], [mobile!, "13px"]]) {
        const sizes = [...scope!.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
          .filter((rule) => rule[1]!.split(",").some((part) => part.trim() === selector))
          .flatMap((rule) => [...rule[2]!.matchAll(/(?:^|;)\s*font(?:-size)?\s*:\s*(\d+px)/g)])
          .map((declaration) => declaration[1]);
        expect(sizes.at(-1)).toBe(size);
      }
    }
    expect(desktop).toMatch(/\.hero-install\s*\{[^}]*width:\s*fit-content/);
    expect(desktop).toMatch(/\.hero-install\s+\.command\s*\{[^}]*display:\s*inline-flex/);
    expect(desktop).toMatch(/\.command\s+pre\s*\{[^}]*scrollbar-width:\s*none/);
    expect(desktop).toMatch(/\.credits-grid\s+article:last-child\s*\{[^}]*grid-column:\s*span\s+2/);
  });

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
      const motionListeners: ((event: { matches: boolean }) => void)[] = [];
      const motionPreference = {
        matches: false,
        addEventListener(type: string, listener: (event: { matches: boolean }) => void) {
          expect(type).toBe("change");
          motionListeners.push(listener);
        },
      };
      const changeMotionPreference = (matches: boolean) => {
        motionPreference.matches = matches;
        for (const listener of motionListeners) listener({ matches });
      };
      runInNewContext(readFileSync(join(outDir, "assets/site.js"), "utf8"), {
        document,
        navigator: { clipboard: { async writeText(text: string) { copied.push(text); } } },
        window: {
          matchMedia: () => motionPreference,
          setTimeout(callback: () => void, delay: number) { timers.push({ callback, delay }); return timers.length; },
        },
      }, { filename: "built/assets/site.js", timeout: 1000 });

      const groups = document.querySelectorAll("[data-tabs]");
      expect(groups).toHaveLength(4);
      const required = [
        ["Recorded workflows", 3],
        ["Product tour stops", 10],
        ["Omarchy and Theme previews", 4],
        ["Headless commands", 3],
      ] as const;

      for (const [label, count] of required) {
        const group = groups.find(
          (item) => item.querySelector('[role="tablist"]').getAttribute("aria-label") === label,
        );
        expect(group).toBeDefined();
        const tabs = group!.querySelectorAll('[role="tab"]');
        expect(tabs).toHaveLength(count);
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
          expect(page.activeElement).toBe(tabs[(index + 1) % tabs.length]!);
        }
        for (let index = 0; index < tabs.length; index++) {
          const current = (tabs.length - index) % tabs.length;
          const next = (current - 1 + tabs.length) % tabs.length;
          tabs[current]!.keydown("ArrowLeft");
          check(next);
          expect(page.activeElement).toBe(tabs[next]!);
        }
        tabs[0]!.keydown("End");
        check(tabs.length - 1);
        expect(page.activeElement).toBe(tabs.at(-1)!);
        tabs.at(-1)!.keydown("Home");
        check(0);
        expect(page.activeElement).toBe(tabs[0]!);
      }

      // The tenth tour stop adds Structure inspection alongside the existing stops.
      const tour = groups.find(
        (item) => item.querySelector('[role="tablist"]').getAttribute("aria-label") === "Product tour stops",
      )!;
      const tourTabs = tour.querySelectorAll('[role="tab"]');
      expect(tourTabs.map((tab) => tab.textContent).at(-1)).toBe("Structure");
      const structureTab = document.getElementById("tour-stop-tab-9");
      const structurePanel = document.getElementById("tour-stop-panel-9");
      expect(structureTab.getAttribute("aria-controls")).toBe("tour-stop-panel-9");
      expect(structurePanel.getAttribute("aria-labelledby")).toBe("tour-stop-tab-9");
      const structureImage = structurePanel.querySelector(".zoomable img");
      expect(structureImage.getAttribute("src")).toBe(mediaUrl("structure.webp"));
      expect(structureImage.getAttribute("width")).toBe("1480");
      expect(structureImage.getAttribute("height")).toBe("980");
      expect(structurePanel.querySelector(".zoomable").getAttribute("aria-label")?.startsWith("Enlarge:")).toBe(true);
      const structureKeys = structurePanel.querySelectorAll("kbd").map((key) => key.textContent);
      expect(structureKeys).toContain("S");
      expect(structureKeys.some((key) => /^(?:space|<leader>) v s$/i.test(key))).toBe(true);
      document.getElementById("tour-stop-tab-8").keydown("ArrowRight");
      expect(structureTab.getAttribute("aria-selected")).toBe("true");
      expect(structurePanel.hidden).toBe(false);
      expect(document.getElementById("tour-stop-panel-8").hidden).toBe(true);
      expect(page.activeElement).toBe(structureTab);
      document.getElementById("tour-stop-tab-0").keydown("End");
      expect(structureTab.getAttribute("aria-selected")).toBe("true");
      expect(structurePanel.hidden).toBe(false);
      expect(page.activeElement).toBe(structureTab);
      structureTab.keydown("Home");
      expect(document.getElementById("tour-stop-tab-0").getAttribute("aria-selected")).toBe("true");
      expect(structurePanel.hidden).toBe(true);
      expect(page.activeElement).toBe(document.getElementById("tour-stop-tab-0"));

      const hero = document.getElementById("hero");
      expect(hero.querySelectorAll('[role="tablist"]')).toHaveLength(0);
      expect(hero.querySelectorAll("[data-tabs]")).toHaveLength(0);
      expect(hero.querySelectorAll(".zoomable")).toHaveLength(1);
      expect(hero.querySelectorAll("img")).toHaveLength(1);
      const heroImage = hero.querySelector(".zoomable img");
      expect(heroImage.getAttribute("src")).toBe(mediaUrl("hero.webp"));
      expect(heroImage.getAttribute("loading")).toBe("eager");
      expect(heroImage.getAttribute("fetchpriority")).toBe("high");
      expect(heroImage.getAttribute("decoding")).toBe("async");
      expect(heroImage.getAttribute("width")).toBe("1480");
      expect(heroImage.getAttribute("height")).toBe("980");
      expect(hero.querySelector("h1").textContent).toBe(
        "Write the query yourself, or ask for it.",
      );
      expect(hero.querySelector(".window-bar").textContent).toContain("losql workspace");
      expect(hero.querySelector(".media-note").textContent).toBe(
        "Schema, Editor, Results and Agent in one terminal workspace. Click any capture to enlarge.",
      );
      expect(hero.querySelectorAll(".actions a").map((link) => link.getAttribute("href"))).toEqual([
        "#quickstart",
        "#tour",
      ]);
      const heroInstall = hero.querySelector(".hero-install");
      expect(heroInstall.querySelector("#hero-install-command").textContent).toBe(
        "curl -fsSL https://raw.githubusercontent.com/DennisLoska/losql/v0.3.0/install.sh | sh",
      );
      expect(
        heroInstall.querySelector('[data-copy="hero-install-command"]').getAttribute("aria-label"),
      ).toBe("Copy install command");
      const heroDirectChildren = hero.children.filter(
        (child): child is typeof hero => typeof child !== "string",
      );
      const installIndex = heroDirectChildren.findIndex((el) => el.matches(".hero-install"));
      const windowIndex = heroDirectChildren.findIndex((el) => el.matches(".hero-window"));
      expect(installIndex).toBeGreaterThan(-1);
      expect(installIndex).toBeLessThan(windowIndex);

      for (const selector of [
        "[data-format]",
        "[data-gif]",
        "[data-fixed-animation]",
        ".format-switch",
        ".workflow-cards",
        ".pill-badge",
        ".status-dot",
        "#navbar nav",
      ]) {
        expect(document.querySelectorAll(selector)).toHaveLength(0);
      }

      const header = document.getElementById("navbar");
      expect(header.querySelector(".brand").getAttribute("href")).toBe("#hero");
      expect(header.querySelectorAll(".header-actions a").map((link) => link.getAttribute("href"))).toEqual([
        "https://github.com/DennisLoska/losql",
        "#quickstart",
      ]);
      expect(header.querySelectorAll("a")).toHaveLength(3);

      const footer = document.getElementById("footer");
      expect(footer.querySelector(".footer-facts").textContent).toBe(
        "Open Source · MIT · SQLite & Postgres · Single Binary · Omarchy First · v0.3.0",
      );
      expect(footer.querySelector(".footer-copy").textContent).toBe(
        "Made for the terminal. © 2026 losql contributors.",
      );
      expect(footer.querySelectorAll("nav a").map((link) => link.getAttribute("href"))).toEqual([
        "https://github.com/DennisLoska/losql/blob/master/LICENSE",
        "https://github.com/DennisLoska/losql",
        "https://github.com/DennisLoska/losql/releases",
      ]);

      const notes = [
        "Result from the bundled demo database.",
        "Captured against the demo database using a deterministic local OpenCode Provider fixture.",
        "Captured from local Provider protocol fixtures; no live Provider service was contacted.",
      ];
      for (const [index, note] of notes.entries()) {
        const paragraphs = document.getElementById(`cli-command-panel-${index}`)
          .querySelectorAll(".caption p");
        expect(paragraphs.at(-1)!.textContent).toBe(note);
      }
      expect(
        document.getElementById("omarchy-mode-panel-2").querySelector(".caption p").textContent,
      ).toBe(
        "Switch between Omarchy, Transparent mode and built-in OpenCode Themes live inside your Session.",
      );

      const motion = document.querySelector(".motion-toggle");
      const recordings = document.querySelectorAll("img[data-static]");
      expect(recordings).toHaveLength(4);
      expect(document.querySelectorAll("#workflows img[data-static]")).toHaveLength(3);
      expect(document.querySelectorAll("#omarchy-mode-panel-2 img[data-static]")).toHaveLength(1);
      expect(motionListeners).toHaveLength(1);

      const checkRecordings = (playing: boolean) => {
        expect(motion.getAttribute("aria-pressed")).toBe(String(playing));
        expect(motion.textContent).toBe(playing ? "Pause recordings" : "Play recordings");
        for (const image of recordings) {
          const source = playing ? image.dataset.webp : image.dataset.static;
          if (source === undefined) throw new Error("Recording source is missing");
          expect(image.getAttribute("src")).toBe(source);
          expect(image.dataset.webp).toMatch(/^\/media\/[\w.-]+\.webp\?v=[0-9a-f]{8}$/);
          expect(image.dataset.webp).toBe(mediaUrl(image.dataset.webp!.slice("/media/".length).split("?")[0]!));
        }
      };

      checkRecordings(true);
      motion.click();
      checkRecordings(false);
      motion.click();
      checkRecordings(true);
      changeMotionPreference(true);
      checkRecordings(false);
      changeMotionPreference(false);
      checkRecordings(true);
      expect(heroImage.getAttribute("src")).toBe(mediaUrl("hero.webp"));

      const copy = document.querySelector("[data-copy]");
      const command = document.getElementById(copy.dataset.copy!).textContent;
      expect(command).toBe(
        "curl -fsSL https://raw.githubusercontent.com/DennisLoska/losql/v0.3.0/install.sh | sh",
      );
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

      const execCopy = document.querySelector('[data-copy="exec-command"]');
      expect(document.getElementById(execCopy.dataset.copy!).textContent).toBe(
        'losql exec -c demo "select count(*) from orders"',
      );

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

      const recordingTrigger = document.querySelector("#workflow-panel-0 .zoomable");
      const recordingImage = recordingTrigger.querySelector("img");
      const recordingStatic = recordingImage.dataset.static;
      const recordingWebp = recordingImage.dataset.webp;
      if (recordingStatic === undefined || recordingWebp === undefined) {
        throw new Error("Recording sources are missing");
      }
      recordingTrigger.click();
      expect(dialog.open).toBe(true);
      expect(enlarged.src).toBe(recordingImage.src);
      expect(enlarged.dataset.static).toBe(recordingStatic);
      expect(enlarged.dataset.webp).toBe(recordingWebp);

      motion.click();
      checkRecordings(false);
      expect(enlarged.getAttribute("src")).toBe(recordingStatic);
      motion.click();
      checkRecordings(true);
      expect(enlarged.getAttribute("src")).toBe(recordingWebp);

      changeMotionPreference(true);
      checkRecordings(false);
      expect(enlarged.getAttribute("src")).toBe(recordingStatic);
      changeMotionPreference(false);
      checkRecordings(true);
      expect(enlarged.getAttribute("src")).toBe(recordingWebp);

      document.querySelector("#hero .zoomable").click();
      expect(dialog.open).toBe(true);
      expect(Object.keys(enlarged.dataset)).toEqual([]);
      expect(enlarged.src).toBe(heroImage.src);
      expect(enlarged.alt).toBe(heroImage.alt);
      motion.click();
      checkRecordings(false);
      expect(enlarged.src).toBe(heroImage.src);
      changeMotionPreference(false);
      checkRecordings(true);
      expect(enlarged.src).toBe(heroImage.src);
      dialog.close();
      expect(enlarged.getAttribute("src")).toBeNull();
      expect(Object.keys(enlarged.dataset)).toEqual([]);

      const reducedPage = createPageDOM(readFileSync(join(outDir, "index.html"), "utf8"));
      runInNewContext(readFileSync(join(outDir, "assets/site.js"), "utf8"), {
        document: reducedPage.document,
        navigator: { clipboard: { async writeText() {} } },
        window: {
          matchMedia: () => ({ matches: true, addEventListener() {} }),
          setTimeout() { return 0; },
        },
      }, { filename: "built/assets/site.js", timeout: 1000 });

      const reducedMotion = reducedPage.document.querySelector(".motion-toggle");
      expect(reducedMotion.getAttribute("aria-pressed")).toBe("false");
      expect(reducedMotion.textContent).toBe("Play recordings");
      for (const image of reducedPage.document.querySelectorAll("img[data-static]")) {
        const source = image.dataset.static;
        if (source === undefined) throw new Error("Recording source is missing");
        expect(image.getAttribute("src")).toBe(source);
      }
      reducedMotion.click();
      expect(reducedMotion.getAttribute("aria-pressed")).toBe("true");
      for (const image of reducedPage.document.querySelectorAll("img[data-static]")) {
        const source = image.dataset.webp;
        if (source === undefined) throw new Error("Recording source is missing");
        expect(image.getAttribute("src")).toBe(source);
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
      if (spec === undefined) throw new Error("Import is missing its module specifier");
      expect(["node:crypto", "node:fs", "node:path", "node:url"]).toContain(spec);
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
        "media/structure.webp",
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
      expect(indexHtml).not.toMatch(/\boutput\b/i);

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

      // All ten tour stops and three WebP recording assets remain represented.
      for (const media of [
        "hero.webp",
        "editor.webp",
        "agent.webp",
        "json.webp",
        "record.webp",
        "structure.webp",
        "zoom.webp",
        "providers.webp",
        "themes.webp",
        "menu.webp",
        "recording-vim.webp",
        "recording-agent.webp",
        "recording-omarchy.webp",
      ]) {
        expect(indexHtml).toContain(media);
      }
      expect(indexHtml).not.toContain(".gif");
      expect(indexHtml).toContain(
        "curl -fsSL https://raw.githubusercontent.com/DennisLoska/losql/v0.3.0/install.sh | sh",
      );
      expect(indexHtml).not.toContain("git clone");
      expect(indexHtml).toContain(
        "Open Source · MIT · SQLite &amp; Postgres · Single Binary · Omarchy First · v0.3.0",
      );

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
          if (attr === undefined) throw new Error("Link is missing its attribute value");
          if (attr.startsWith("#")) {
            expect(ids.has(attr.slice(1))).toBe(true);
            continue;
          }
          if (/^(?:https?:\/\/|mailto:|data:)/.test(attr)) continue;

          const localPath = attr.split(/[?#]/, 1)[0];
          if (localPath === undefined) throw new Error(`Link has no local path: ${attr}`);
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

  test("built index.html versions every /media/ reference with the file's content hash", () => {
    const outDir = mkdtempSync(join(tmpdir(), "losql-landing-cache-bust-"));
    try {
      const build = spawnSync("node", [BUILD_SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, LANDING_OUT: outDir },
        encoding: "utf8",
      });
      expect(build.status).toBe(0);
      const indexHtml = readFileSync(join(outDir, "index.html"), "utf8");

      // (a) Every /media/ reference, relative or absolute, carries ?v=<hash8> of the real bytes.
      const references = [...indexHtml.matchAll(/(?:https:\/\/losql\.dev)?\/media\/([^"'\s?#<>]+)(\?[^"'\s#<>]*)?/g)];
      expect(references.length).toBeGreaterThan(0);
      for (const [reference, name, query] of references) {
        expect(existsSync(join(MEDIA_DIR, name!))).toBe(true);
        expect({ reference, query }).toEqual({ reference, query: `?v=${mediaHash(name!)}` });
      }
      const contexts: [string, RegExp][] = [
        ["src", /\bsrc="\/media\//],
        ["href", /\bhref="\/media\//],
        ["data-webp", /\bdata-webp="\/media\//],
        ["data-static", /\bdata-static="\/media\//],
        ["og:image", /property="og:image" content="https:\/\/losql\.dev\/media\//],
        ["twitter:image", /name="twitter:image" content="https:\/\/losql\.dev\/media\//],
        ["JSON-LD screenshot", /"screenshot":"https:\/\/losql\.dev\/media\//],
      ];
      for (const [name, pattern] of contexts) expect({ name, present: pattern.test(indexHtml) }).toEqual({ name, present: true });
      for (const [attribute, pattern] of [
        ["src", /\bsrc="(\/media\/[^"]*)"/g],
        ["data-webp", /\bdata-webp="(\/media\/[^"]*)"/g],
        ["data-static", /\bdata-static="(\/media\/[^"]*)"/g],
      ] as const) {
        for (const [, url] of indexHtml.matchAll(pattern)) {
          const name = url!.slice("/media/".length).split("?")[0]!;
          expect({ attribute, url }).toEqual({ attribute, url: mediaUrl(name) });
        }
      }

      // (b) The hero preload and the hero <img> request the identical versioned URL.
      const page = createPageDOM(indexHtml);
      const preload = page.document.querySelectorAll('link[rel="preload"]').find((link) => link.getAttribute("as") === "image");
      const heroSrc = page.document.querySelector("#hero .zoomable img").getAttribute("src");
      expect(heroSrc).toBe(mediaUrl("hero.webp"));
      expect(preload?.getAttribute("href")).toBe(heroSrc);

      // Sources and the other generated files stay canonical.
      expect(readFileSync(join(ROOT, "landing/src/index.html"), "utf8")).not.toContain("?v=");
      for (const file of ["404.html", "sitemap.xml", "robots.txt", "llms.txt", "site.webmanifest"]) {
        expect({ file, versioned: readFileSync(join(outDir, file), "utf8").includes("?v=") }).toEqual({ file, versioned: false });
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("built site includes comprehensive SEO metadata, JSON-LD structured data, image sitemap, llms.txt, and webmanifest", () => {
    const outDir = mkdtempSync(join(tmpdir(), "losql-landing-seo-"));
    try {
      const build = spawnSync("node", [BUILD_SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, LANDING_OUT: outDir },
        encoding: "utf8",
      });
      expect(build.status).toBe(0);

      const indexHtml = readFileSync(join(outDir, "index.html"), "utf8");
      expect(indexHtml).toContain('<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">');
      expect(indexHtml).toContain('<meta name="color-scheme" content="dark">');
      expect(indexHtml).toContain('<meta name="application-name" content="losql">');
      expect(indexHtml).toContain('<link rel="canonical" href="https://losql.dev/">');
      expect(indexHtml).toContain('<link rel="manifest" href="/site.webmanifest">');
      expect(indexHtml).toContain('<link rel="preload" href="/fonts/JetBrainsMono-latin.woff2" as="font" type="font/woff2" crossorigin>');
      expect(indexHtml).toContain(`<link rel="preload" href="${mediaUrl("hero.webp")}" as="image" type="image/webp" fetchpriority="high">`);

      // Open Graph & Twitter Cards
      expect(indexHtml).toContain('<meta property="og:site_name" content="losql">');
      expect(indexHtml).toContain('<meta property="og:locale" content="en_US">');
      expect(indexHtml).toContain('<meta property="og:image:width" content="1480">');
      expect(indexHtml).toContain('<meta property="og:image:height" content="980">');
      expect(indexHtml).toContain('<meta property="og:image:alt"');
      expect(indexHtml).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(indexHtml).toContain('<meta name="twitter:title"');
      expect(indexHtml).toContain('<meta name="twitter:description"');
      expect(indexHtml).toContain(`<meta name="twitter:image" content="https://losql.dev${mediaUrl("hero.webp")}">`);
      expect(indexHtml).toContain(`<meta property="og:image" content="https://losql.dev${mediaUrl("hero.webp")}">`);
      expect(indexHtml).toContain('<meta name="twitter:image:alt"');

      // JSON-LD Structured Data
      const jsonLdMatch = indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      expect(jsonLdMatch?.[1]).toBeDefined();
      const structuredData = JSON.parse(jsonLdMatch![1]!) as {
        "@context": string;
        "@graph": Array<Record<string, unknown>>;
      };
      expect(structuredData["@context"]).toBe("https://schema.org");
      const appNode = structuredData["@graph"].find((node) => node["@type"] === "SoftwareApplication");
      const siteNode = structuredData["@graph"].find((node) => node["@type"] === "WebSite");
      expect(appNode).toBeDefined();
      expect(appNode?.["name"]).toBe("losql");
      expect(appNode?.["applicationCategory"]).toBe("DeveloperApplication");
      expect(appNode?.["softwareVersion"]).toBe("0.3.0");
      expect(appNode?.["codeRepository"]).toBe("https://github.com/DennisLoska/losql");
      expect(appNode?.["screenshot"]).toBe(`https://losql.dev${mediaUrl("hero.webp")}`);
      expect(siteNode).toBeDefined();
      expect(siteNode?.["url"]).toBe("https://losql.dev/");

      // Sitemap, llms.txt & site.webmanifest
      const sitemap = readFileSync(join(outDir, "sitemap.xml"), "utf8");
      expect(sitemap).toContain("http://www.google.com/schemas/sitemap-image/1.1");
      expect(sitemap).toContain("<image:loc>https://losql.dev/media/hero.webp</image:loc>");
      expect(sitemap).toContain("<image:loc>https://losql.dev/media/structure.webp</image:loc>");

      const llmsTxt = readFileSync(join(outDir, "llms.txt"), "utf8");
      expect(llmsTxt).toContain("# losql");
      expect(llmsTxt).toContain("https://losql.dev/");
      expect(llmsTxt).toContain("https://github.com/DennisLoska/losql");
      expect(llmsTxt).toContain("v0.3.0/install.sh");

      const manifest = JSON.parse(readFileSync(join(outDir, "site.webmanifest"), "utf8")) as Record<string, unknown>;
      expect(manifest["name"]).toBe("losql");
      expect(manifest["theme_color"]).toBe("#000000");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

