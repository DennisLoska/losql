# losql.dev Landing Page & Decoupled NixOS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SKILL: invoke the dispatch skill via the skill tool to implement this plan task-by-task. Execution is subagent-driven only: never execute inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an authentic, accessible static landing page for `https://losql.dev` with fresh screenshots and animated screen recordings from the compiled `losql` binary, and an offline `node landing/build.mjs` builder suitable for decoupled NixOS deployment via `nixos-vps` on `flux`.

**Auto-approved:** auto-approve: true

**Architecture:** `landing/scripts/capture-media.ts` drives the compiled `./losql` binary inside an isolated `tmux` session on the `demo` database, rendering terminal ANSI states into crisp static WebP screenshots and animated WebP/GIF workflow recordings (`landing/public/media/*` and `readme/*.webp`) alongside self-hosted WOFF2 fonts (`landing/public/fonts/*`). `landing/build.mjs` uses only Node 22 built-in modules (`node:fs`, `node:path`, `node:url`) to assemble `landing/src/*` and `landing/public/*` into `LANDING_OUT` (default `landing/dist`) so `nixos-vps` can build `losql-landing-dist` offline inside the Nix sandbox from the `losql` GitHub flake input.

**Tech Stack:** Bun 1.3+, TypeScript, Node 22 built-ins (`node:fs`, `node:path`, `node:url`), `tmux`, headless Chromium / Playwright, `ffmpeg` / ImageMagick (`magick`), vanilla HTML5 / CSS3 / ES2022.

**Spec:** `docs/specs/2026-11-16-losql-landing-page-design.md`. **Glossary:** `GLOSSARY.md` (`Connection`, `Session`, `Driver`, `Schema snapshot`, `Relation`, `Buffer`, `Statement`, `Run`, `Result`, `Result view`, `Record`, `Provider`, `Model`, `Agent`, `Conversation`, `Turn`, `Step`, `Proposal`, `Pane`, `Command`, `Leader`, `Theme`, `Transparent`).

---

## File Structure

```text
landing/
  build.mjs                         Dependency-free Node ES module static builder (LANDING_OUT support)
  src/
    index.html                      Main landing page template (Musy + t3.codes dark aesthetic)
    404.html                        Branded 404 error page template
    site.css                        Pure black (#000000 / #080808) design system, glass header, animations
    site.js                         Accessible tab switchers, workflow/tour/Omarchy controls, copy buttons
  public/
    favicon.svg                     losql terminal prompt vector icon
    fonts/
      PlusJakartaSans-latin.woff2   Self-hosted display/body font
      JetBrainsMono-latin.woff2     Self-hosted terminal monospace font
      OFL-PlusJakartaSans.txt       Font license
      OFL-JetBrainsMono.txt         Font license
    media/
      manifest.json                 SHA-256 hashes, dimensions, and provenance of all captured media
      hero.webp                     Latest 4-Pane workspace screenshot (active Pane border, widened Agent Pane)
      editor.webp                   Vim modal editor with schema completion popup
      agent.webp                    Agent Pane with user card, read-only query Steps, and Proposal card
      json.webp                     Results Pane in JSON Result view
      record.webp                   Results Pane in Record view
      zoom.webp                     Results Pane zoomed full-screen (space z)
      providers.webp                Provider selection dialog (Claude Code, Codex, OpenCode, Antigravity)
      themes.webp                   Theme dialog showing omarchy and 7 built-in OpenCode themes
      menu.webp                     Leader key (space) popup menu
      onboarding.webp               First-start welcome / setup screen
      omarchy.webp                  Workspace rendered in the Omarchy live colors.toml palette
      omarchy-transparent.webp      Workspace in Omarchy theme with Transparent mode (:set transparent)
      workflow-tour.webp            Animated WebP hero product tour across panes and views
      workflow-tour.gif             Animated GIF hero product tour
      recording-vim.webp            Animated WebP of modal Vim SQL editing, completion, Run, and Result views
      recording-vim.gif             Animated GIF of modal Vim SQL editing workflow
      recording-agent.webp          Animated WebP of Agent Turn, read-only Steps, and Proposal card
      recording-agent.gif           Animated GIF of Agent Turn and Proposal workflow
      recording-omarchy.webp        Animated WebP of live Omarchy theme switching and Transparent mode
      recording-omarchy.gif         Animated GIF of live Omarchy theme switching and Transparent mode
  scripts/
    capture-media.ts                Drives ./losql in tmux, renders ANSI frames via Chromium, encodes WebP/GIF
  tests/
    media.test.ts                   Verifies captured screenshots, animated recordings, fonts, and manifest
    landing.test.ts                 Verifies build.mjs, HTML structure, glossary/credits, and anti-fake/fork rules
```

---

### Task 1: Authentic Media Capture Pipeline, Self-Hosted Fonts & Latest Screenshots / Recordings

**Files:**
- Create: `landing/scripts/capture-media.ts`
- Create: `landing/public/fonts/PlusJakartaSans-latin.woff2` (copied from `/home/dennis/work/musy/public/fonts/`)
- Create: `landing/public/fonts/JetBrainsMono-latin.woff2` (copied from `/home/dennis/work/musy/public/fonts/`)
- Create: `landing/public/fonts/OFL-PlusJakartaSans.txt`
- Create: `landing/public/fonts/OFL-JetBrainsMono.txt`
- Create: `landing/public/media/*` (`hero.webp`, `editor.webp`, `agent.webp`, `json.webp`, `record.webp`, `zoom.webp`, `providers.webp`, `themes.webp`, `menu.webp`, `onboarding.webp`, `omarchy.webp`, `omarchy-transparent.webp`, `workflow-tour.webp`, `workflow-tour.gif`, `recording-vim.webp`, `recording-vim.gif`, `recording-agent.webp`, `recording-agent.gif`, `recording-omarchy.webp`, `recording-omarchy.gif`, `manifest.json`)
- Modify: `readme/*.webp` (updated with latest captures from the compiled `./losql` binary)
- Test: `landing/tests/media.test.ts`

- [ ] **Step 1: Write the failing test (`landing/tests/media.test.ts`)**

```typescript
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MEDIA_DIR = join(ROOT, "landing", "public", "media");
const FONTS_DIR = join(ROOT, "landing", "public", "fonts");
const README_DIR = join(ROOT, "readme");

const REQUIRED_STATIC = [
  "hero.webp",
  "editor.webp",
  "agent.webp",
  "json.webp",
  "record.webp",
  "zoom.webp",
  "providers.webp",
  "themes.webp",
  "menu.webp",
  "onboarding.webp",
  "omarchy.webp",
  "omarchy-transparent.webp",
];

const REQUIRED_ANIMATED = [
  "workflow-tour.webp",
  "workflow-tour.gif",
  "recording-vim.webp",
  "recording-vim.gif",
  "recording-agent.webp",
  "recording-agent.gif",
  "recording-omarchy.webp",
  "recording-omarchy.gif",
];

const REQUIRED_FONTS = [
  "PlusJakartaSans-latin.woff2",
  "JetBrainsMono-latin.woff2",
  "OFL-PlusJakartaSans.txt",
  "OFL-JetBrainsMono.txt",
];

describe("landing media and fonts", () => {
  test("self-hosted WOFF2 fonts and OFL licenses exist", () => {
    for (const file of REQUIRED_FONTS) {
      const full = join(FONTS_DIR, file);
      expect(existsSync(full)).toBe(true);
      expect(statSync(full).size).toBeGreaterThan(100);
    }
  });

  test("all static WebP screenshots and animated WebP/GIF recordings exist and are valid", () => {
    for (const file of [...REQUIRED_STATIC, ...REQUIRED_ANIMATED]) {
      const full = join(MEDIA_DIR, file);
      expect(existsSync(full)).toBe(true);
      const buf = readFileSync(full);
      expect(buf.byteLength).toBeGreaterThan(2048);
      if (file.endsWith(".webp")) {
        expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(buf.subarray(8, 12).toString("ascii")).toBe("WEBP");
      } else if (file.endsWith(".gif")) {
        expect(buf.subarray(0, 4).toString("ascii")).toBe("GIF8");
      }
    }
  });

  test("manifest.json tracks sha256 and dimensions for all media files", () => {
    const manifestPath = join(MEDIA_DIR, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      binarySha256: string;
      assets: Record<string, { sha256: string; bytes: number; width: number; height: number; animated?: boolean; frames?: number }>;
    };
    expect(typeof manifest.binarySha256).toBe("string");
    expect(manifest.binarySha256.length).toBe(64);

    for (const file of [...REQUIRED_STATIC, ...REQUIRED_ANIMATED]) {
      const entry = manifest.assets[file];
      expect(entry).toBeDefined();
      const buf = readFileSync(join(MEDIA_DIR, file));
      const sha = createHash("sha256").update(buf).digest("hex");
      expect(entry!.sha256).toBe(sha);
      expect(entry!.bytes).toBe(buf.byteLength);
      expect(entry!.width).toBeGreaterThanOrEqual(800);
      expect(entry!.height).toBeGreaterThanOrEqual(450);
    }

    for (const anim of REQUIRED_ANIMATED) {
      expect(manifest.assets[anim]!.animated).toBe(true);
      expect(manifest.assets[anim]!.frames).toBeGreaterThanOrEqual(3);
    }
  });

  test("readme/*.webp screenshots match the latest captured media", () => {
    for (const name of [
      "hero.webp",
      "editor.webp",
      "agent.webp",
      "json.webp",
      "record.webp",
      "zoom.webp",
      "providers.webp",
      "themes.webp",
      "menu.webp",
      "onboarding.webp",
    ]) {
      const readmeBuf = readFileSync(join(README_DIR, name));
      const mediaBuf = readFileSync(join(MEDIA_DIR, name));
      expect(readmeBuf.equals(mediaBuf)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test landing/tests/media.test.ts`
Expected: FAIL because `landing/public/fonts` and `landing/public/media/manifest.json` do not exist yet.

- [ ] **Step 3: Implement `landing/scripts/capture-media.ts` and generate all fonts, screenshots, and animated recordings**

Write `landing/scripts/capture-media.ts` that:
1. Copies `PlusJakartaSans-latin.woff2`, `JetBrainsMono-latin.woff2`, `OFL-PlusJakartaSans.txt`, and `OFL-JetBrainsMono.txt` from `/home/dennis/work/musy/public/fonts/` into `landing/public/fonts/`.
2. Ensures `./losql` is built (`bun run build`) and drives `./losql demo` inside an isolated `tmux` session (`losql-capture-$$`) with temporary `LOSQL_CONFIG_DIR`, `LOSQL_STATE_DIR`, and `XDG_STATE_HOME` (containing an authentic Omarchy `colors.toml` at `$XDG_STATE_HOME/omarchy/current/theme/colors.toml` and a deterministic agent shim binary on `PATH` when testing the Agent Turn so the real `losql` Agent loop executes live `describe` + `query` Steps against the SQLite `demo` database and renders the real OpenCode user card, Step rows, and SQL Proposal card).
3. Captures `tmux capture-pane -p -e -N` ANSI screens for every state (`onboarding`, `hero`, `editor`, `agent`, `json`, `record`, `zoom`, `providers`, `themes`, `menu`, `omarchy`, `omarchy-transparent`) plus multi-step frame sequences for `workflow-tour`, `recording-vim`, `recording-agent`, and `recording-omarchy`.
4. Parses ANSI 24-bit RGB foreground/background escape sequences into HTML spans styled with the local `JetBrainsMono-latin.woff2` inside a crisp macOS/terminal window frame, screenshots each frame with headless Chromium (`chromium --headless` or Playwright), and encodes static `.webp` images and multi-frame animated `.webp` and `.gif` recordings via `magick` / `ffmpeg`.
5. Copies the 10 core static `.webp` files to `readme/*.webp` and writes `landing/public/media/manifest.json`.

- [ ] **Step 4: Run `capture-media.ts` and verify `landing/tests/media.test.ts` passes**

Run: `bun run landing/scripts/capture-media.ts && bun test landing/tests/media.test.ts`
Expected: PASS (all tests in `landing/tests/media.test.ts` pass).

- [ ] **Step 5: Commit**

```bash
git add landing/scripts/capture-media.ts landing/tests/media.test.ts landing/public/fonts landing/public/media readme
git commit -m "feat(landing): add authentic tmux media capture pipeline and latest screenshots/recordings"
```

---

### Task 2: Dependency-Free Static Landing Builder (`landing/build.mjs`), Templates, Styling & Interactivity

**Files:**
- Create: `landing/build.mjs`
- Create: `landing/src/index.html`
- Create: `landing/src/404.html`
- Create: `landing/src/site.css`
- Create: `landing/src/site.js`
- Create: `landing/public/favicon.svg`
- Modify: `package.json`
- Modify: `.gitignore`
- Test: `landing/tests/landing.test.ts`

- [ ] **Step 1: Write the failing test (`landing/tests/landing.test.ts`)**

```typescript
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..", "..");
const BUILD_SCRIPT = join(ROOT, "landing", "build.mjs");

describe("landing/build.mjs and page content", () => {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test landing/tests/landing.test.ts`
Expected: FAIL because `landing/build.mjs` and `landing/src/*` do not exist yet.

- [ ] **Step 3: Implement `landing/build.mjs`, `landing/src/index.html`, `landing/src/404.html`, `landing/src/site.css`, `landing/src/site.js`, `landing/public/favicon.svg`, `.gitignore`, and `package.json`**

Implement:
- `landing/build.mjs` using only `node:fs`, `node:path`, and `node:url`. Reads `process.env.LANDING_OUT` (defaulting to `landing/dist`), validates required source files and media assets, cleans and populates `LANDING_OUT` with `index.html`, `404.html`, `robots.txt`, `sitemap.xml`, `favicon.svg`, `assets/site.css`, `assets/site.js`, `fonts/*`, and `media/*`.
- `landing/src/site.css`: Musy + `t3.codes` pure black (`#000000` / `#080808`) aesthetic, self-hosted `@font-face` rules for `Plus Jakarta Sans` and `JetBrains Mono`, `.t3-header` sticky blur navbar, `.btn-primary` and `.btn-secondary` pills, `.showcase-window` terminal chrome, 12-column editorial grids, animated workflow badges, tour tab bar, Omarchy palette cards, and responsive mobile rules.
- `landing/src/index.html`: Complete semantic HTML5 landing page covering all 9 sections in the spec (Navbar, Hero with static/animated toggle, 3 Animated Workflows in `.webp` + `.gif`, 9-stop Interactive Product Tour, Neovim + OpenCode + Harlequin/LazySQL DNA, Omarchy-First interactive theme & transparency showcase, Headless CLI & Scripting tabs, Quick Start & Installation with copyable commands, Credits & Inspirations with links, and Footer).
- `landing/src/404.html`: Branded 404 page matching the dark terminal aesthetic.
- `landing/src/site.js`: Keyboard-accessible tabs (`ArrowLeft`/`ArrowRight`/`Home`/`End`) for Workflows, Product Tour, Omarchy theme preview, and CLI commands; WebP/GIF format toggle; Hero live workflow toggle; copy-to-clipboard buttons with confirmation state; lightbox zoom for screenshots.
- Add `"landing:build": "node ./landing/build.mjs"` to `package.json` scripts and `landing/dist` to `.gitignore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test landing/tests/landing.test.ts && bun run landing:build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add landing/build.mjs landing/src landing/public/favicon.svg landing/tests/landing.test.ts package.json .gitignore
git commit -m "feat(landing): build losql.dev static landing page and offline builder"
```

---

### Task 3: End-to-End Browser & Build Verification + Documentation Update

**Files:**
- Modify: `landing/tests/landing.test.ts` (add DOM/link/asset integrity checks and headless browser smoke test)
- Modify: `README.md` (add link to `https://losql.dev` in header)

- [ ] **Step 1: Write the failing test in `landing/tests/landing.test.ts`**

Add tests in `landing/tests/landing.test.ts` asserting that:
1. Every `src="..."` and local `href="..."` referenced in `index.html` and `404.html` resolves to an existing file in `LANDING_OUT` or a valid `#id` anchor in `index.html`.
2. `README.md` links to `https://losql.dev`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test landing/tests/landing.test.ts`
Expected: FAIL because `README.md` does not yet link to `https://losql.dev`.

- [ ] **Step 3: Update `README.md` and ensure all local asset/anchor integrity checks pass**

Add `<a href="https://losql.dev">losql.dev</a> •` to the navigation links at the top of `README.md` and ensure all anchors and asset paths in `landing/src/index.html` and `landing/src/404.html` resolve cleanly.

- [ ] **Step 4: Run full test suite to verify everything passes**

Run: `bun run check && bun run landing:build`
Expected: PASS (`tsc --noEmit` and all `bun test` suites including `landing/tests/*` pass).

- [ ] **Step 5: Commit**

```bash
git add README.md landing/tests/landing.test.ts
git commit -m "docs: link losql.dev in README and verify landing asset/anchor integrity"
```
