# Spec: Landing Page Product Polish (`feat/landing-product-polish`)

auto-approve: true ("using oneshot" under Default autonomy mode)

## Purpose & Scope

Polish `https://losql.dev` (`landing/src/index.html`, `landing/src/site.css`, `landing/src/site.js`, and `landing/tests/landing.test.ts`) into a clean, user-friendly developer product page with less visual clutter:

1. **Remove the WebP / GIF toggle and format clutter:**
   - Remove the 3-tab format switcher (`Static Workspace` / `Live Tour Animation (WebP)` / `Animated GIF`) from `#hero` so the hero showcase window presents a single clean, zoomable product capture (`/media/hero.webp`).
   - Remove `.format-switch` (`WebP` / `GIF` buttons) and the duplicate `.workflow-cards` raw file link strip (`Open WebP ↗` / `GIF ↗`) from `#workflows`.
   - Standardize all in-page recordings (`#workflows` and `#omarchy-mode-panel-2`) on animated WebP (`data-webp` + `data-static`), governed by `.motion-toggle` and `prefers-reduced-motion: reduce`, with no `data-gif` or `data-fixed-animation` attributes.
   - Update `#omarchy-mode-panel-2` caption so it does not mention choosing WebP or GIF.
2. **Remove the small pill card above the main headline and move that metadata to the footer:**
   - Remove `<div class="pill-badge eyebrow"><span class="status-dot"></span>Open Source · MIT · SQLite &amp; Postgres · Single Binary · Omarchy First</div>` above `<h1>` in `#hero`.
   - Move `Open Source · MIT · SQLite & Postgres · Single Binary · Omarchy First · v0.2.0` into `#footer` as clean, readable footer metadata alongside the copyright line and footer links (`MIT License`, `GitHub`, `Releases`).
3. **Remove the navigation tabs from the header (`#navbar`):**
   - Remove `<nav aria-label="Main navigation">...</nav>` and `.pill-badge.version` from `#navbar`.
   - Keep only the brand link (`losql`) on the left and a right-aligned `.header-actions` group containing `GitHub ↗` and `Quick Start`.
4. **Polish typography, layout spacing, and product copy:**
   - Streamline hero actions to `Get started` and `Interactive tour` (since `GitHub ↗` is in the sticky header), and simplify the hero window bar to `losql workspace`.
   - Refine `#cli` provenance captions so they remain 100% truthful without exposing internal fixture jargon.
   - Increase supporting/caption text legibility (`14px`–`15px` desktop, `13px` mobile), align `.nav-inner` with `.container`, give interactive controls comfortable hit targets, and remove unused CSS rules (`.format-switch`, `.workflow-cards`, `.pill-badge`, `.status-dot`, `@keyframes pulseDot`).

## Approaches Considered

| Approach | Design | Trade-off |
| --- | --- | --- |
| 1. Minimal surgical removal | Delete the requested DOM nodes (`<nav>`, `.pill-badge`, `.format-switch`, `.workflow-cards`, hero tabs) and keep existing CSS/copy unchanged. | Leaves the header action buttons unaligned (`.nav-inner nav` previously carried `margin-left: auto`), leaves small 10px–12px caption sizes, and keeps verbose capture notes. |
| **2. Focused product polish (Chosen)** | Clean static hero window, streamlined header with `.header-actions { margin-left: auto }`, WebP-only motion controller in `site.js`, refined product copy and typography scale in `site.css`, and moved metadata in `#footer`. | Requires coordinated updates across `index.html`, `site.css`, `site.js`, and `landing.test.ts`, while keeping the build pipeline (`build.mjs`) and all media assets intact. |
| 3. Full layout restructuring | Collapse all tabbed sections (`#tour`, `#omarchy`, `#cli`) into long-scroll static grids. | Loses the interactive 9-stop product tour and keyboard tab navigation that showcase `losql` features compactly. |

**Rationale for Approach 2:** Directly fulfills every user requirement while fixing layout dependencies (such as header right-alignment after removing `<nav>`) and elevating visual polish without discarding the interactive tour or breaking the zero-dependency Nix build.

## Architecture & Component Changes

### 1. `landing/src/index.html` (auto-approved)
- **Header (`#navbar`):**
  - `<div class="nav-inner"><a class="brand" href="#hero" aria-label="losql home"><img src="/favicon.svg" width="28" height="28" alt="">losql</a><div class="header-actions"><a class="btn btn-secondary github-nav" href="https://github.com/DennisLoska/losql">GitHub ↗</a><a class="btn btn-primary" href="#quickstart">Quick Start</a></div></div>`
  - No `<nav>` tabs and no `.pill-badge` in `#navbar`.
- **Hero (`#hero`):**
  - Starts directly with `<h1>Write the query yourself, or ask for it.</h1>` (no `.pill-badge.eyebrow` card above `<h1>`).
  - Subtitle: `<p class="hero-subtitle">A vim-first SQL client for the terminal, with an agent on board. SQLite and Postgres, one binary, no API keys.</p>`
  - Actions: `<div class="actions"><a class="btn btn-primary" href="#quickstart">Get started <span aria-hidden="true">↗</span></a><a class="btn btn-secondary" href="#tour">Interactive tour</a></div>`
  - Showcase window (`.showcase-window.hero-window`):
    - `.window-bar`: `<span class="window-dots" aria-hidden="true">● ● ●</span><span>losql workspace</span>`
    - Single `.zoomable` button with `<img src="/media/hero.webp" alt="Workspace with Schema, Editor, Results and Agent Panes" loading="eager" fetchpriority="high" decoding="async" width="1480" height="980">` (no `[data-tabs]` or tablist in `#hero`).
  - Media note: `<p class="media-note">Schema, Editor, Results and Agent in one terminal workspace. Click any capture to enlarge.</p>`
- **Workflows (`#workflows`):**
  - `.media-controls`: contains only `<button type="button" class="motion-toggle" aria-pressed="false">Play recordings</button><span>Select any capture to enlarge.</span>` (no `.format-switch`).
  - Three workflow tabs (`01 · Vim`, `02 · Agent`, `03 · Omarchy`) use `data-webp` and `data-static` only (no `data-gif`).
  - Remove `.workflow-cards` below `#workflows > .tab-group`.
- **Omarchy (`#omarchy`):**
  - `#omarchy-mode-panel-2` uses `data-webp="/media/recording-omarchy.webp" data-static="/media/omarchy.webp"` (no `data-gif`) and caption: `<p>Switch between Omarchy, Transparent mode and built-in OpenCode Themes live inside your Session.</p>`.
- **CLI (`#cli`):**
  - Keep all 3 tabs (`losql exec`, `losql ask`, `losql providers`), commands, copy buttons, and captured `stdout`/`stderr` blocks verbatim.
  - Streamline the secondary provenance lines into clean, truthful product notes:
    - Panel 0 (`exec`): `<p>Result from the bundled demo database.</p>`
    - Panel 1 (`ask`): `<p>Captured against the demo database using a deterministic local OpenCode Provider fixture.</p>`
    - Panel 2 (`providers`): `<p>Captured from local Provider protocol fixtures; no live Provider service was contacted.</p>`
- **Footer (`#footer`):**
  - Contains brand `<a class="brand" href="#hero">&gt;_ losql</a>`, `<div class="footer-meta"><p class="footer-facts">Open Source · MIT · SQLite &amp; Postgres · Single Binary · Omarchy First · v0.2.0</p><p class="footer-copy">Made for the terminal. © 2026 losql contributors.</p></div>`, and `<nav aria-label="Footer"><a href="https://github.com/DennisLoska/losql/blob/master/LICENSE">MIT License</a><a href="https://github.com/DennisLoska/losql">GitHub</a><a href="https://github.com/DennisLoska/losql/releases">Releases</a></nav>`.
- **Preserved invariants:**
  - All glossary terms (`Schema`, `Buffer`, `Statement`, `Result view`, `Proposal`, `Provider`, `Transparent`, `SQLite`, `Postgres`), all 9 tour stops, all credit links, and all `<head>` SEO metadata + JSON-LD remain intact.

### 2. `landing/src/site.css` (auto-approved)
- Align `.nav-inner` width with `.container` (`width: min(1200px, calc(100% - 64px)); margin-inline: auto; min-height: 70px; padding: 12px 0; display: flex; align-items: center; justify-content: space-between; gap: 16px;`) and style `.header-actions { display: flex; align-items: center; gap: 12px; margin-left: auto; }`.
- Remove `.pill-badge`, `.status-dot`, `@keyframes pulseDot`, `.format-switch`, `.workflow-cards`, and `.nav-inner nav` rules.
- Adjust `.hero h1 { max-width: 900px; margin: 0 auto 24px; }` so top spacing does not depend on a removed badge.
- Polish `.caption p` (`font-size: 14px; line-height: 1.7;`), `.media-controls`, and `.footer-meta` / `.footer-facts` / `.footer-copy` for clean product hierarchy across desktop and mobile (`@media (max-width: 700px)`).

### 3. `landing/src/site.js` (auto-approved)
- Remove `let format = 'webp'`, `[data-format]` click listeners, `dataset.fixedAnimation`, and `dataset.gif` handling.
- In `updateRecordings()`:
  - For each `img[data-static]`, set `const source = playing ? image.dataset.webp : image.dataset.static;`.
  - Guard `if (motionButton)` when updating text and `aria-pressed`.
- In lightbox open handler:
  - Clear `enlargedImage.dataset` first so static images never inherit stale attributes from a previously opened recording, then copy `['static', 'webp']` dataset keys if present.

### 4. `landing/tests/landing.test.ts` (auto-approved)
- Update the DOM smoke test:
  - Verify the 4 remaining `[data-tabs]` groups (`Recorded workflows` = 3 tabs, `Product tour stops` = 9 tabs, `Omarchy and Theme previews` = 4 tabs, `Headless commands` = 3 tabs).
  - Verify `#hero` has no `[role="tablist"]` and displays a single zoomable `/media/hero.webp` image.
  - Verify `.motion-toggle` toggles `img[data-static]` between `data-webp` and `data-static`, and test `motionPreference` change listener behavior.
  - Verify `[data-format]`, `data-gif`, `data-fixed-animation`, `.workflow-cards`, `.pill-badge`, and `#navbar nav` are absent from the built HTML.
  - Verify `#footer` contains `Open Source · MIT · SQLite &amp; Postgres · Single Binary · Omarchy First · v0.2.0` (text content `Open Source · MIT · SQLite & Postgres · Single Binary · Omarchy First · v0.2.0`).
  - Verify lightbox state cleanup when opening a recording and then opening the static hero image.

## Assumptions
1. Existing `.gif` files in `landing/public/media/` remain in the repository and build output (`landing/build.mjs`) for external/archive use, while the landing page UI exclusively uses `.webp` for recordings.
2. Once merged into `master`, the updated `DennisLoska/losql` flake input will be deployed to `nixos-vps` on `flux` so `https://losql.dev` reflects the polished design immediately.
