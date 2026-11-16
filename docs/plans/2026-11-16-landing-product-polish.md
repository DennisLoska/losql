# Landing Page Product Polish Implementation Plan

> **For agentic workers:** REQUIRED SKILL: invoke the dispatch skill via the skill tool to implement this plan task-by-task. Execution is subagent-driven only: never execute inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the landing page with a clean static hero, simplified header, readable typography, truthful CLI captions, footer metadata, and WebP-only recordings.

**Auto-approved:** auto-approve: true

**Architecture:** Preserve the static HTML/CSS page, zero-dependency build, existing tab navigation, clipboard behavior, and native lightbox. Simplify the shared motion controller to select between each recording's `data-webp` and `data-static` sources. Test the actual built HTML and JavaScript together through the existing deterministic DOM harness.

**Tech Stack:** HTML, CSS, vanilla JavaScript, Node standard-library build script, Bun tests, TypeScript, `node:vm`.

---

### Task 1: Polish landing page markup, styles, WebP motion controller, and DOM smoke tests

**Files:**
- Modify: `landing/tests/landing.test.ts`
- Modify: `landing/src/index.html`
- Modify: `landing/src/site.js`
- Modify: `landing/src/site.css`

- [ ] **Step 1: Write the failing test (`tester` red step)**

In `landing/tests/landing.test.ts`, update the interactive DOM smoke test and build-content assertions while keeping `createPageDOM()` unchanged:

1. Replace `const motionPreference = { matches: false, addEventListener() {} };` with:
```ts
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
```

2. Replace the `groups`, `required`, and loop-opening declarations immediately after `runInNewContext()` with:
```ts
const groups = document.querySelectorAll("[data-tabs]");
expect(groups).toHaveLength(4);
const required = [
  ["Recorded workflows", 3],
  ["Product tour stops", 9],
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
```

3. Replace everything from `const staticTab = ...` through the old format-switch test (stopping immediately before `const copy = ...`) with:
```ts
const hero = document.getElementById("hero");
expect(hero.querySelectorAll('[role="tablist"]')).toHaveLength(0);
expect(hero.querySelectorAll("[data-tabs]")).toHaveLength(0);
expect(hero.querySelectorAll(".zoomable")).toHaveLength(1);
expect(hero.querySelectorAll("img")).toHaveLength(1);
const heroImage = hero.querySelector(".zoomable img");
expect(heroImage.getAttribute("src")).toBe("/media/hero.webp");
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
  "Open Source · MIT · SQLite & Postgres · Single Binary · Omarchy First · v0.2.0",
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
    expect(image.dataset.webp).toEndWith(".webp");
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
expect(heroImage.getAttribute("src")).toBe("/media/hero.webp");
```

4. Immediately after the existing lightbox close loop inside the smoke test's `try` block, add:
```ts
const recordingTrigger = document.querySelector("#workflow-panel-0 .zoomable");
const recordingImage = recordingTrigger.querySelector("img");
recordingTrigger.click();
expect(dialog.open).toBe(true);
expect(enlarged.src).toBe(recordingImage.src);
expect(enlarged.dataset.static).toBe(recordingImage.dataset.static);
expect(enlarged.dataset.webp).toBe(recordingImage.dataset.webp);

motion.click();
checkRecordings(false);
expect(enlarged.getAttribute("src")).toBe(recordingImage.dataset.static);
motion.click();
checkRecordings(true);
expect(enlarged.getAttribute("src")).toBe(recordingImage.dataset.webp);

changeMotionPreference(true);
checkRecordings(false);
expect(enlarged.getAttribute("src")).toBe(recordingImage.dataset.static);
changeMotionPreference(false);
checkRecordings(true);
expect(enlarged.getAttribute("src")).toBe(recordingImage.dataset.webp);

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
  expect(image.getAttribute("src")).toBe(image.dataset.static);
}
reducedMotion.click();
expect(reducedMotion.getAttribute("aria-pressed")).toBe("true");
for (const image of reducedPage.document.querySelectorAll("img[data-static]")) {
  expect(image.getAttribute("src")).toBe(image.dataset.webp);
}
```

5. In the build-content test, replace the `// All 9 Tour stops & 3 Animated recordings` loop with:
```ts
// All nine tour stops and three WebP recording assets remain represented.
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
  "recording-agent.webp",
  "recording-omarchy.webp",
]) {
  expect(indexHtml).toContain(media);
}
expect(indexHtml).not.toContain(".gif");
expect(indexHtml).toContain(
  "Open Source · MIT · SQLite &amp; Postgres · Single Binary · Omarchy First · v0.2.0",
);
```

- [ ] **Step 2: Run test to verify it fails (`tester` red verification)**

Run: `bun test landing/tests/landing.test.ts`
Expected: FAIL because `index.html` still has 5 `[data-tabs]` groups and references `.gif` files.

- [ ] **Step 3: Write minimal implementation (`implementer` green step)**

1. In `landing/src/index.html`:
   - Replace `#navbar`:
     ```html
     <header id="navbar" class="t3-header"><div class="nav-inner"><a class="brand" href="#hero" aria-label="losql home"><img src="/favicon.svg" width="28" height="28" alt="">losql</a><div class="header-actions"><a class="btn btn-secondary github-nav" href="https://github.com/DennisLoska/losql">GitHub ↗</a><a class="btn btn-primary" href="#quickstart">Quick Start</a></div></div></header>
     ```
   - Replace `#hero`:
     ```html
     <section id="hero" class="container hero"><h1>Write the query yourself, or ask for it.</h1><p class="hero-subtitle">A vim-first SQL client for the terminal, with an agent on board. SQLite and Postgres, one binary, no API keys.</p><div class="actions"><a class="btn btn-primary" href="#quickstart">Get started <span aria-hidden="true">↗</span></a><a class="btn btn-secondary" href="#tour">Interactive tour</a></div><div class="showcase-window hero-window"><div class="window-bar"><span class="window-dots" aria-hidden="true">● ● ●</span><span>losql workspace</span></div><button class="zoomable" type="button" aria-label="Enlarge: Workspace with Schema, Editor, Results and Agent Panes"><img src="/media/hero.webp" alt="Workspace with Schema, Editor, Results and Agent Panes" loading="eager" fetchpriority="high" decoding="async" width="1480" height="980"></button></div><p class="media-note">Schema, Editor, Results and Agent in one terminal workspace. Click any capture to enlarge.</p></section>
     ```
   - In `#workflows`:
     - Replace `.media-controls` with `<div class="media-controls"><button type="button" class="motion-toggle" aria-pressed="false">Play recordings</button><span>Select any capture to enlarge.</span></div>`
     - Remove `data-gif` from `#workflow-panel-0`, `#workflow-panel-1`, and `#workflow-panel-2` `<img>` elements.
     - Remove `.workflow-cards`.
   - In `#omarchy`:
     - Remove `data-gif` from `#omarchy-mode-panel-2` `<img>` and update its caption `<p>` to `Switch between Omarchy, Transparent mode and built-in OpenCode Themes live inside your Session.`
   - In `#cli`:
     - Replace the final provenance `<p>` in `#cli-command-panel-0`, `#cli-command-panel-1`, and `#cli-command-panel-2` with:
       - `Result from the bundled demo database.`
       - `Captured against the demo database using a deterministic local OpenCode Provider fixture.`
       - `Captured from local Provider protocol fixtures; no live Provider service was contacted.`
   - Replace `#footer`:
     ```html
     <footer id="footer" class="container"><a class="brand" href="#hero">&gt;_ losql</a><div class="footer-meta"><p class="footer-facts">Open Source · MIT · SQLite &amp; Postgres · Single Binary · Omarchy First · v0.2.0</p><p class="footer-copy">Made for the terminal. © 2026 losql contributors.</p></div><nav aria-label="Footer"><a href="https://github.com/DennisLoska/losql/blob/master/LICENSE">MIT License</a><a href="https://github.com/DennisLoska/losql">GitHub</a><a href="https://github.com/DennisLoska/losql/releases">Releases</a></nav></footer>
     ```

2. In `landing/src/site.js`:
   - Replace the motion section and `.zoomable` handler so `updateRecordings()` uses `playing ? image.dataset.webp : image.dataset.static` and lightbox clears `enlargedImage.dataset` before copying `['static', 'webp']`:
     ```js
     const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
     let playing = !motionPreference.matches;
     const motionButton = document.querySelector('.motion-toggle');
     function updateRecordings() {
       for (const image of document.querySelectorAll('img[data-static]')) {
         const source = playing ? image.dataset.webp : image.dataset.static;
         if (image.getAttribute('src') !== source) image.setAttribute('src', source);
       }
       if (motionButton) {
         motionButton.textContent = playing ? 'Pause recordings' : 'Play recordings';
         motionButton.setAttribute('aria-pressed', String(playing));
       }
     }
     if (motionButton) {
       motionButton.addEventListener('click', () => {
         playing = !playing;
         updateRecordings();
       });
     }
     motionPreference.addEventListener('change', (event) => {
       playing = !event.matches;
       updateRecordings();
     });
     updateRecordings();
     ```
     and in `.zoomable`:
     ```js
     for (const button of document.querySelectorAll('.zoomable')) {
       button.addEventListener('click', () => {
         const image = button.querySelector('img');
         for (const key of Object.keys(enlargedImage.dataset)) delete enlargedImage.dataset[key];
         enlargedImage.src = image.getAttribute('src') || image.src;
         enlargedImage.alt = image.alt;
         for (const key of ['static', 'webp']) {
           if (image.dataset[key]) enlargedImage.dataset[key] = image.dataset[key];
         }
         lightbox.showModal();
       });
     }
     ```

3. In `landing/src/site.css`:
   - Update `.nav-inner`, add `.header-actions`, remove `.pill-badge`, `.status-dot`, `@keyframes pulseDot`, `.nav-inner nav`, `.format-switch`, `.workflow-cards`, and `.window-status`, and update `.hero h1`, `.caption p`, `.media-controls`, `.motion-toggle`, `.footer-meta`, `.footer-facts`, `.footer-copy`, and responsive breakpoints as specified in Step 5 of the planner draft.

- [ ] **Step 4: Run tests to verify they pass (`implementer` green verification)**

Run: `bun test landing/tests/landing.test.ts && bun run check`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add landing/tests/landing.test.ts landing/src/index.html landing/src/site.js landing/src/site.css
git commit -m "feat(landing): polish product page and simplify WebP recordings"
```
