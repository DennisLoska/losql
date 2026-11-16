# losql.dev Landing Page & Decoupled NixOS VPS Deployment — Design Specification

- `auto-approve: true` ("Use Oneshot Harness to implement this I approve all the designs, so do not stop, do not ask me I want you to drive us end to end until the PR is merged and the pages deployed, and respond to me back with the link to the page")
- **Date:** 2026-11-16
- **Repository:** `DennisLoska/losql` (landing page source, capture pipeline, and tests) + `DennisLoska/nixos-vps` (decoupled Nix flake input, Caddy loopback service, Cloudflare Tunnel ingress, and deployment on `flux`)
- **Target URL:** `https://losql.dev`

---

## 1. Purpose & Positioning

Create and deploy the official landing page for **losql** at `https://losql.dev`.

**losql** is a 100% open-source (MIT) vim-first SQL client for the terminal, with an Agent on board. It connects to SQLite and Postgres in a single compiled binary with no server and no API keys to paste — driving the coding-agent CLIs already installed on your `PATH` (Claude Code, Codex, OpenCode, Antigravity).

The page sells `losql` authentically as:
- A focused synthesis of **[Neovim](https://neovim.io)** (modal editing, motions, operators, `is`/`as` SQL Statement text objects, registers, dot repeat, completion) and **[OpenCode](https://opencode.ai)** (structured Agent Turns, read-only database Steps, user cards, Proposal cards that never run without confirmation, and OpenCode-format Themes).
- A fast, keyboard-first terminal UI and headless CLI inspired by **[Harlequin](https://harlequin.sh)** and **[LazySQL](https://github.com/jorgerojas26/lazysql)**, built with **[OpenTUI](https://github.com/anomalyco/opentui)** and **[Bun](https://bun.sh)**.
- **Omarchy-first in mind:** First-class integration with **[Omarchy](https://omarchy.org)** — the built-in `omarchy` Theme reads Omarchy's active `colors.toml` (`~/.local/state/omarchy/current/theme/colors.toml` or `~/.config/omarchy/current/theme/colors.toml`), respects the system palette, and updates live when the system theme changes, alongside `:set transparent` (`ctrl+t`) so terminal background blur shines through.

### Strict Content Integrity Rules
1. **No mocked or fake content:** Zero fake tweets, zero fabricated testimonials, zero invented user counts or telemetry numbers. Every screenshot, animated screen recording, and CLI output shown on the page comes from running the real compiled `losql` binary on the bundled `demo` database.
2. **No fork/steal encouragement:** Do not include "Steal our code", "If you don't like something, fork it", or fork buttons. Present `losql` as a clean, welcoming MIT open-source project.
3. **No GitHub star count badges:** Do not display star counters in the navbar or hero since the project just started.
4. **Ubiquitous Language:** All UI copy, captions, and code comments strictly honor `GLOSSARY.md` terms: **Connection**, **Session**, **Driver**, **Schema snapshot**, **Relation**, **Buffer**, **Statement**, **Run**, **Result**, **Result view** (`Table`, `JSON`, `Record`), **Record**, **Provider**, **Model**, **Agent**, **Conversation**, **Turn**, **Step**, **Proposal**, **Pane** (`Schema`, `Editor`, `Results`, `Agent`), **Command**, **Leader**, **Theme**, and **Transparent**.

---

## 2. Architectural Approaches & Recommendation

*(Section status: `auto-approved`)*

| Approach | Description | Pros | Trade-offs |
| --- | --- | --- | --- |
| **A. Dependency-Free Static Builder (`landing/build.mjs`) + Committed Authentic Media Pipeline (`landing/scripts/capture-media.ts`) — Recommended** | `landing/build.mjs` uses only Node/Bun built-in standard library modules (`node:fs`, `node:path`, `node:url`, `node:crypto`) to validate, assemble, and copy `landing/src/*` and `landing/public/*` into `LANDING_OUT` (default `landing/dist`). A separate developer script (`landing/scripts/capture-media.ts`) drives the real `losql` binary in `tmux` and renders high-DPI screenshots and animated recordings (`.webp` / `.gif`) via headless Chromium + `ffmpeg`/`magick`. | Runs 100% offline inside the Nix build sandbox (`pkgs.runCommand` with `pkgs.nodejs_22`) exactly like `lothendil-landing.nix`. Zero npm install needed on the NixOS VPS. Fast, deterministic, zero-drift output. | Interactive tabs and theme switcher are written in clean vanilla JS (`site.js`) and standard CSS (`site.css`) rather than a heavy SPA bundler. |
| **B. Vite + Tailwind Build Inside Nix (`buildNpmPackage`)** | Build a Vite app inside `landing/` with `package.json` and compile it during Nix evaluation using `buildNpmPackage` or `bun`. | Familiar Vite dev server workflow. | Requires maintaining npm/bun lockfile hashes inside `nixos-vps` whenever dependencies change; brittle in air-gapped Nix sandboxes. |
| **C. Client-Side ANSI Player in Browser** | Ship raw ANSI/asciinema casts to the browser and render terminal frames via a JS canvas player. | Tiny recording files. | Does not produce portable `.gif`/`.webp` animated images, can suffer font-rendering differences across visitor OSes, and adds unnecessary client JS complexity. |

**Chosen Approach:** **Approach A.** It mirrors the proven decoupled `lothendil-landing.nix` pattern in `nixos-vps` while adopting the exact visual design system of `musy/apps/landing` and `t3.codes`.

---

## 3. Visual Design System (Musy + t3.codes Reference)

*(Section status: `auto-approved`)*

- **Color Palette (Pure Black Editorial Surface):**
  - `--bg`: `#000000` (page canvas)
  - `--bg-elev`: `#050505` (window header bar / inset code blocks)
  - `--bg-card`: `#080808` (cards, showcase window frame, feature panels)
  - `--fg`: `#f5f5f5` (primary headings and high-contrast text)
  - `--fg-muted`: `#a3a3a3` (secondary copy)
  - `--fg-dim`: `#8a8a8a` (metadata, window captions, terminal labels)
  - `--border`: `rgba(255, 255, 255, 0.08)` (hairline structural dividers)
  - `--border-strong`: `rgba(255, 255, 255, 0.15)` (interactive card & pill borders)
  - `--accent`: `#7aa2f7` (Tokyo Night blue highlight) & `#bb9af7` (Agent purple accent), with warm Omarchy gold/terracotta accents (`#e9bf6f` / `#b86a66`) in the Omarchy showcase section.
- **Typography:**
  - Self-hosted WOFF2 fonts in `landing/public/fonts/` (`PlusJakartaSans-latin.woff2` and `JetBrainsMono-latin.woff2` with OFL licenses) — zero external Google Fonts requests, fast loading, strict privacy.
  - Display & UI (`--font-sans`): `'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`, tight tracking (`-0.04em`), crisp line-height (`1.06` on hero title).
  - Terminal, keys & code (`--font-mono`): `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`.
- **Components & Chrome:**
  - **Sticky Glassmorphic Header (`.t3-header`):** `background: rgba(0, 0, 0, 0.82); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border)`.
  - **Pill Buttons (`.btn-primary`, `.btn-secondary`):** High-contrast white pill (`#ffffff` bg, `#000000` text, `font-weight: 600`, `border-radius: 9999px`) and subtle translucent pill (`rgba(255,255,255,0.05)` bg, `rgba(255,255,255,0.15)` border).
  - **Minimalist Showcase Frame (`.showcase-window`):** `#080808` container, `1px solid rgba(255,255,255,0.12)`, `border-radius: 0.875rem`, deep ambient shadow `0 24px 80px rgba(0,0,0,0.85)`, top bar with three subtle window dots, centered monospace command title (`losql demo`), and live status indicator (`NORMAL · demo · sqlite`).
  - **Animations:** Subtle CSS reveal animations (`@keyframes fadeUp`, `@keyframes pulseGlow`), smooth tab crossfades, animated terminal workflow recordings (`.webp` and `.gif`), and full `prefers-reduced-motion: reduce` support.

---

## 4. Page Sections & Content Architecture

*(Section status: `auto-approved`)*

1. **Sticky Navbar (`#navbar`):**
   - Left: `losql` terminal glyph mark + `losql` wordmark + version pill (`v0.2.0 · MIT`).
   - Center links: `Tour`, `Workflows`, `Omarchy & Themes`, `Agent`, `CLI`, `Quick Start`, `Credits`.
   - Right actions: GitHub repository pill link (`GitHub` — no star counter) + primary white pill CTA (`Quick Start` -> `#quickstart`).

2. **Hero Section (`#hero`):**
   - Eyebrow badge: `Open Source · MIT · Single Binary · SQLite & Postgres`
   - Title: *Write the query yourself, or ask for it.*
   - Subtitle: *A vim-first SQL client for the terminal, with an agent on board. Modal editing, live schema completion, table/JSON/record views, and read-only agent steps powered by the coding CLI you already have installed. Designed with Omarchy first in mind.*
   - CTAs: Primary pill `Get started` (`#quickstart`), Secondary pill `Interactive tour` (`#tour`), Secondary pill `View on GitHub` (`https://github.com/DennisLoska/losql`).
   - Hero Showcase Window: Displays the latest high-resolution workspace capture (`hero.webp`) with a toggle to switch directly to the **Animated Workflow Recording** (`workflow-tour.webp` / `workflow-tour.gif`) showing live modal SQL editing, running a Statement, inspecting Results, and Agent Proposal cards in the updated 4-Pane layout (with active Pane border highlight and widened Agent Pane).

3. **Animated Workflows & Screen Recordings (`#workflows`):**
   - Three real screen recordings captured from the latest `losql` binary (available as animated WebP and GIF with interactive tab switcher + side-by-side cards):
     1. **Modal Vim Editing & Result Views (`recording-vim.webp` / `.gif`):** Typing SQL with live schema completion (`ctrl+n`), running with `Enter`, switching `Table` -> `JSON` -> `Record` (`Tab`), and full-screen zooming (`space z`).
     2. **Agent Steps & Safe Proposals (`recording-agent.webp` / `.gif`):** Asking a question in the widened Agent Pane (`space a i`), watching the Agent execute read-only schema/query Steps (`▸ query ... -> rows`), and reviewing the highlighted SQL Proposal card (`Enter` to accept into Buffer, `r` to Run).
     3. **Omarchy Live Theme & Transparency (`recording-omarchy.webp` / `.gif`):** Opening the Theme dialog (`space t`), previewing `omarchy` (live `colors.toml` tracking) across built-in palettes (`tokyonight`, `catppuccin`, `gruvbox`, `nord`, `rosepine`, `kanagawa`, `everforest`), and toggling Transparent mode (`ctrl+t` / `:set transparent`).

4. **Interactive Product Tour (`#tour`):**
   - 9 interactive tour stops with keyboard-accessible tabs (`ArrowLeft`/`ArrowRight`) and instant visual switching, all freshly captured from the current `losql` binary:
     - `Workspace` (`hero.webp`): All four Panes (`SCHEMA`, `EDITOR`, `RESULTS`, `AGENT`) with active Pane border highlight.
     - `Vim Editor & Completion` (`editor.webp`): Insert mode with live schema column/table popup (`ctrl+n`), `is`/`as` Statement text objects.
     - `Agent & Steps` (`agent.webp`): OpenCode-style user card, read-only query Steps, and Proposal card.
     - `JSON View` (`json.webp`): Syntax-highlighted JSON Result view (`Tab`), `yy` to yank row as JSON.
     - `Record View` (`record.webp`): Vertical field-by-field inspection of a single row (`Enter`).
     - `Full-Screen Zoom` (`zoom.webp`): `space z` expands Results across the entire terminal.
     - `Coding CLI Providers` (`providers.webp`): Uses Claude Code, Codex, OpenCode, or Antigravity already on your `PATH` — no API keys to paste.
     - `Themes & Omarchy` (`themes.webp`): Live Theme preview dialog with `omarchy` and 7 built-in OpenCode themes + `ctrl+t` transparency toggle.
     - `Leader Menu` (`menu.webp`): `space` opens the contextual key menu; `ctrl+p` searches every Command; `F1` opens help.

5. **The DNA: Neovim + OpenCode + Harlequin & LazySQL (`#dna`):**
   - Editorial 12-column breakdown (matching Musy / t3.codes layout) explaining how `losql` combines:
     - **Neovim ergonomics:** Modal buffers, operators (`d`, `c`, `y`, `>`, `<`), text objects (`is`/`as` for SQL Statement), registers, dot repeat, undo/redo, `/` regex search, and `shift+h/j/k/l` Pane navigation.
     - **OpenCode agent & theme architecture:** Ephemeral, sandboxed coding CLI turns; visible read-only database Steps; Proposal cards that never execute unprompted; and 100% compatibility with OpenCode theme JSON files (`~/.config/losql/themes/<name>.json`).
     - **Harlequin & LazySQL terminal craft:** Schema tree navigation, Relation peeking, fast result inspection, and zero-config in-process SQLite + Postgres Drivers.

6. **Omarchy First in Mind (`#omarchy`):**
   - Dedicated showcase highlighting `losql`'s native Omarchy support:
     - Interactive switch between **`omarchy` (System Palette)**, **`omarchy` (Transparent Mode)**, and **`tokyonight`** captures (`omarchy.webp`, `omarchy-transparent.webp`, `themes.webp`), plus the animated theme transition (`recording-omarchy.webp` / `.gif`).
     - Explains how `losql` watches `~/.local/state/omarchy/current/theme/colors.toml` and `~/.config/omarchy/current/theme/colors.toml`, mapping Omarchy's `colors.toml` tokens directly to UI, border, and SQL syntax tokens and repainting live on change.

7. **Headless CLI & Scripting (`#cli`):**
   - Interactive copyable command tabs for `losql exec`, `losql ask`, and `losql providers` with real terminal output from `losql demo`.

8. **Quick Start & Installation (`#quickstart`):**
   - Build from source with Bun into a single standalone binary (`git clone https://github.com/DennisLoska/losql.git && cd losql && bun install && bun run build`), plus one-click copy buttons for launching `losql demo`, SQLite files, and Postgres URLs.

9. **Credits & Inspirations (`#credits`) + Footer (`#footer`):**
   - Explicit credits cards with direct clickable links to:
     - **[Neovim](https://neovim.io)** — Modal editing model, motions, operators, text objects, and keybind philosophy.
     - **[OpenCode](https://opencode.ai)** ([GitHub](https://github.com/sst/opencode)) — Agent interaction patterns, user/proposal cards, and JSON theme format.
     - **[Omarchy](https://omarchy.org)** — Live system `colors.toml` theme integration and transparent terminal aesthetic.
     - **[Harlequin](https://harlequin.sh)** — Terminal SQL IDE inspiration.
     - **[LazySQL](https://github.com/jorgerojas26/lazysql)** — Keyboard-driven TUI SQL workflow inspiration.
     - **[OpenTUI](https://github.com/anomalyco/opentui)** & **[Bun](https://bun.sh)** — Core terminal rendering engine and single-binary runtime.
   - Footer with MIT License link, GitHub repo link, Releases link, and clean copyright notice.

---

## 5. Authentic Screenshot & Screen Recording Pipeline

*(Section status: `auto-approved`)*

`landing/scripts/capture-media.ts` drives the compiled `./losql` binary inside an isolated `tmux` session (`140x40` cells) against the bundled `demo` database:
1. Captures exact ANSI color + cell states (`tmux capture-pane -p -e -N`) for every Tour state and multi-frame workflow sequence.
2. Renders each terminal frame through a pixel-accurate HTML/SVG terminal frame template using local `JetBrains Mono` font and headless Chromium (`playwright`), complete with the macOS/terminal window chrome matching `readme/*.webp`.
3. Writes updated, latest static WebP screenshots to both `landing/public/media/` and `readme/` (so the repo README and landing page stay in sync with commit `18ab135`'s active Pane borders and widened Agent Pane).
4. Assembles multi-frame sequences into animated WebP (`workflow-tour.webp`, `recording-vim.webp`, `recording-agent.webp`, `recording-omarchy.webp`) and animated GIF (`recording-vim.gif`, `recording-agent.gif`, `recording-omarchy.gif`) via `ffmpeg` / `magick`, and writes `landing/public/media/manifest.json` with SHA-256 hashes and dimensions.

---

## 6. Decoupled NixOS VPS Integration (`nixos-vps` on `flux`)

*(Section status: `auto-approved`)*

In `/home/dennis/work/nixos-vps`:
1. **`flake.nix`:**
   - Add input:
     ```nix
     inputs.losql = {
       url = "git+ssh://git@github.com/DennisLoska/losql.git?ref=master";
       flake = false;
     };
     ```
   - Pass `losqlSrc = losql;` in `specialArgs` and wire `services.losql-landing` from `settings.losqlLanding`.
2. **`services/losql-landing.nix`:**
   - Define `options.services.losql-landing` (`enable`, `port` default `8082`, `domain` default `"losql.dev"`).
   - Build `siteRoot` using `pkgs.runCommand "losql-landing-dist" { nativeBuildInputs = [pkgs.nodejs_22]; }` executing `LANDING_OUT="$out" node "${losqlSrc}/landing/build.mjs"`.
   - Configure loopback-only Caddy virtualHost `":${toString cfg.port}"` (`bind 127.0.0.1`, `root * ${siteRoot}`, `encode zstd gzip`, clean URLs, `/404.html` error handling) and Cloudflare Tunnel ingress for `${cfg.domain}` (`http://127.0.0.1:${toString cfg.port}`).
3. **`settings.nix`:**
   - Enable `losqlLanding = { enable = true; port = 8082; domain = "losql.dev"; };`.
4. **Cloudflare Tunnel DNS & Deployment on `flux`:**
   - Route `losql.dev` to tunnel `5faaa2ea-d078-4f1e-8779-f52270a7a99f` via `cloudflared tunnel route dns 5faaa2ea-d078-4f1e-8779-f52270a7a99f losql.dev`.
   - Once `losql` PR is merged to `master`, run `nix flake update losql` and `just deploy` in `/home/dennis/work/nixos-vps`, then verify `https://losql.dev` end-to-end.

---

## 7. Verification & Testing Strategy

*(Section status: `auto-approved`)*

1. **Unit & Build Tests (`landing/tests/landing.test.ts` run via `bun test`):**
   - Verifies `node landing/build.mjs` succeeds with zero external dependencies into a temp `LANDING_OUT`.
   - Verifies `index.html`, `404.html`, `robots.txt`, `sitemap.xml`, fonts, styles, scripts, and all screenshots (`*.webp`) + animated recordings (`*.webp`, `*.gif`) + `manifest.json` exist and are non-empty.
   - Verifies required content: positioning copy, Omarchy section (`colors.toml`, `transparent`), credits links (`https://neovim.io`, `https://opencode.ai`, `https://github.com/sst/opencode`, `https://omarchy.org`, `https://harlequin.sh`, `https://github.com/jorgerojas26/lazysql`, `https://github.com/anomalyco/opentui`, `https://bun.sh`).
   - Enforces negative content guards: no `"Steal our code"`, no `"fork it"`, no `/fork` links, no GitHub star count badges, no fake tweets/testimonials.
2. **Existing Project Suite (`bun run check`):**
   - `bun run typecheck` and `bun run test` pass with zero regressions.
3. **Live Deployment Verification:**
   - `curl -fsSI https://losql.dev` returns HTTP 200 and serves the deployed landing page.

---

## 8. Derived Assumptions

- Single-locale English (`en`) static landing site at `https://losql.dev` with a branded `404.html`.
- `landing/build.mjs` is invoked by NixOS via `node "${losqlSrc}/landing/build.mjs"` with `LANDING_OUT="$out"`, keeping `losql` and `nixos-vps` completely decoupled via GitHub flake input.
- All design sections and the spec are auto-approved per the user's explicit instruction.
