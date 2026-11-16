/** Run from any directory: bun landing/scripts/capture-media.ts
 * Requires bun, tmux, magick, Chromium and Playwright (PLAYWRIGHT_MODULE can
 * point to its index.mjs). Provider shims are deterministic capture fixtures;
 * all database work and terminal rendering run through the compiled binary.
 */
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const media = join(root, "landing/public/media");
const fonts = join(root, "landing/public/fonts");
const work = await mkdtemp(join(tmpdir(), "losql-capture-"));
const session = `losql-capture-${process.pid}`;
// A separate server also prevents inherited tmux environment/config changing a capture.
const socket = join(work, "tmux.sock");
const pane = `=${session}:`;
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
async function run(args: string[], allowFailure = false) {
  const p = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code && !allowFailure) throw new Error(`${args[0]} failed (${code}): ${err}\n${out}`);
  return out;
}
const tmux = (...args: string[]) => run(["tmux", "-S", socket, ...args]);
const pause = (ms = 250) => Bun.sleep(ms);
async function keys(...args: string[]) { for (const key of args) { await tmux("send-keys", "-t", pane, key); await pause(100); } await pause(); }
async function text(value: string) { await tmux("send-keys", "-t", pane, "-l", "--", value); await pause(); }
const screen = () => tmux("capture-pane", "-p", "-e", "-N", "-t", pane);
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
async function waitFor(value: string) {
  for (let i = 0; i < 80; i++) {
    const s = plain(await screen());
    if (s.includes(value)) return;
    await pause(100);
  }
  throw new Error(`Capture expected ${JSON.stringify(value)}:\n${plain(await screen())}`);
}
async function command(value: string) { await keys(":"); await text(value); await keys("Enter"); }
async function focus(direction: string) { await keys("C-w", direction); }

// Preserve every SGR foreground/background cell, including default backgrounds
// (transparent in the screenshot), rather than recolouring terminal text.
function ansiHtml(ansi: string) {
  const palette = ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#ffffff"];
  const indexed = (n: number) => n < 16 ? palette[n]! : n >= 232
    ? `rgb(${[0, 0, 0].map(() => 8 + (n - 232) * 10).join(",")})`
    : `rgb(${[Math.floor((n - 16) / 36), Math.floor((n - 16) / 6) % 6, (n - 16) % 6].map(v => [0, 95, 135, 175, 215, 255][v]).join(",")})`;
  let fg = "#c0caf5", bg = "transparent", bold = false, reverse = false;
  let html = "";
  for (const chunk of ansi.split(/(\x1b\[[0-9;]*m)/)) {
    if (chunk.startsWith("\x1b[")) {
      const codes = chunk.slice(2, -1).split(";").map(v => Number(v));
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i]!;
        if (c === 0) { fg = "#c0caf5"; bg = "transparent"; bold = reverse = false; }
        else if (c === 1) bold = true;
        else if (c === 22) bold = false;
        else if (c === 7) reverse = true;
        else if (c === 27) reverse = false;
        else if (c === 39) fg = "#c0caf5";
        else if (c === 49) bg = "transparent";
        else if (c === 38 || c === 48) {
          const type = codes[++i];
          let color: string;
          if (type === 2) { color = `rgb(${codes.slice(i + 1, i + 4).join(",")})`; i += 3; }
          else if (type === 5) color = indexed(codes[++i]!);
          else throw new Error(`Unsupported SGR colour: ${chunk}`);
          if (c === 38) fg = color; else bg = color;
        } else if (c >= 30 && c <= 37) fg = indexed(c - 30);
        else if (c >= 90 && c <= 97) fg = indexed(c - 90 + 8);
        else if (c >= 40 && c <= 47) bg = indexed(c - 40);
        else if (c >= 100 && c <= 107) bg = indexed(c - 100 + 8);
      }
    } else if (chunk) {
      // The Latin font uses fallback glyphs for box drawing. Fixed terminal
      // cells keep fallback advance widths from breaking Pane borders.
      for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(chunk)) {
        if (segment === "\n") { html += "\n"; continue; }
        const escaped = segment.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        html += `<span style="display:inline-block;vertical-align:top;height:21px;width:${Bun.stringWidth(segment)}ch;color:${reverse ? bg : fg};background:${reverse ? fg : bg};font-weight:${bold ? 700 : 400}">${escaped}</span>`;
      }
    }
  }
  return html;
}

let browser: { close(): Promise<void> } | undefined;
try {
  await mkdir(media, { recursive: true });
  await mkdir(fonts, { recursive: true });
  for (const file of ["PlusJakartaSans-latin.woff2", "JetBrainsMono-latin.woff2", "OFL-PlusJakartaSans.txt", "OFL-JetBrainsMono.txt"]) {
    await copyFile(join(process.env.CAPTURE_FONT_SOURCE ?? "/home/dennis/work/musy/public/fonts", file), join(fonts, file));
  }
  await run(["bun", "run", "build"]);
  const binarySha256 = sha(await readFile(join(root, "losql")));
  const config = join(work, "config"), state = join(work, "state"), xdg = join(work, "xdg");
  await mkdir(config); await mkdir(state); await mkdir(join(work, "bin"));
  const themeDir = join(xdg, "omarchy/current/theme");
  await mkdir(themeDir, { recursive: true });
  const sourceTheme = process.env.CAPTURE_OMARCHY_COLORS ?? "/home/dennis/.local/state/omarchy/current/theme/colors.toml";
  const fallbackTheme = `mode = "dark"\naccent = "#b86a66"\nselection = "#2c292a"\nselection_foreground = "#141112"\nmuted = "#716a6d"\nbackground = "#141112"\ndark_background = "#0f0d0e"\ndarker_background = "#0a0909"\nlighter_background = "#2c292a"\nforeground = "#F9E9CC"\ndark_foreground = "#bbaf99"\nlight_foreground = "#faecd4"\nbright_foreground = "#fbefd9"\nred = "#c48a62"\nyellow = "#ffe98d"\norange = "#cd9c7a"\ngreen = "#e9bf6f"\ncyan = "#f8dd67"\nblue = "#b86a66"\nmagenta = "#f09376"\nbrown = "#7b5e49"\nbright_red = "#e59b69"\nbright_yellow = "#ffe168"\nbright_green = "#ffd466"\nbright_cyan = "#fff156"\nbright_blue = "#d87975"\nbright_magenta = "#ffa17b"\n`;
  await writeFile(join(themeDir, "colors.toml"), await readFile(sourceTheme, "utf8").catch(() => fallbackTheme));
  await writeFile(join(config, "config.json"), JSON.stringify({ agent: { provider: "opencode", model: "default" }, animations: false }));
  const revenue = `select c.name, c.country,\n       round(sum(i.quantity * i.unit_price), 2)\n         as revenue\nfrom customers c\njoin orders o on o.customer_id = c.id\njoin order_items i on i.order_id = o.id\ngroup by c.id\norder by revenue desc;`;
  // These executables never connect to a provider. OpenCode's actual stream
  // envelope wraps protocol actions consumed by the application's real loop.
  const fixture = `#!${process.execPath}\nconst args = process.argv.slice(2);\nif(args.includes('--version')) { console.log('1.0.0 capture-fixture'); process.exit(0); }\nif(args[0] === 'models') { console.log('default'); process.exit(0); }\nconst prompt = await Bun.stdin.text();\nconst step = prompt.includes('<result>');\nawait Bun.sleep(step ? 1600 : 1000);\nconst action = step ? {action:'answer',message:'Revenue by customer, verified against the demo database. Ada leads with multiple orders. Review the SQL before running.',sql:${JSON.stringify(revenue)}} : {action:'query',sql:'select c.name, count(o.id) as orders from customers c join orders o on o.customer_id = c.id group by c.id',why:'Check customer orders before proposing revenue SQL'};\nconsole.log(JSON.stringify({type:'text',part:{text:JSON.stringify(action)}}));\n`;
  for (const name of ["claude", "codex", "opencode", "antigravity"]) {
    await writeFile(join(work, "bin", name), fixture); await chmod(join(work, "bin", name), 0o755);
  }
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const launch = `LOSQL_CONFIG_DIR=${quote(config)} LOSQL_STATE_DIR=${quote(state)} XDG_STATE_HOME=${quote(xdg)} LOSQL_NO_ANIMATIONS=1 TERM=xterm-256color COLORTERM=truecolor PATH=${quote(`${work}/bin:${process.env.PATH}`)} ${quote(join(root, "losql"))} demo`;
  await tmux("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "140", "-y", "40", launch);
  await tmux("set-option", "-g", "default-terminal", "tmux-256color");
  const captures = new Map<string, { ansi: string; transparent: boolean }>();
  async function capture(name: string, expected: string, transparent = false) {
    await waitFor(expected); await pause(200);
    const ansi = await screen();
    captures.set(name, { ansi, transparent });
    await writeFile(join(work, `${name}.ansi`), ansi);
    console.log(`Captured ${name}`);
  }
  await capture("onboarding", "get started");
  await keys("Escape"); await waitFor("SCHEMA");
  // Expand the Relation without replacing the active Statement.
  await focus("h"); await keys("j", "l"); await focus("l");
  await keys("g", "g", "d", "G", "i");
  // Bracketed paste preserves SQL newlines as editor content.
  await tmux("set-buffer", "-b", session, revenue);
  await tmux("paste-buffer", "-p", "-r", "-d", "-b", session, "-t", pane);
  await keys("Escape"); await command(`w ${join(work, "revenue.sql")}`); await keys("Enter"); await waitFor("8 rows");
  await keys("Space", "a", "a"); await capture("agent-open", "AGENT");
  await text("Show revenue by customer");
  await capture("agent-question", "Show revenue"); await keys("Enter");
  await waitFor("query"); await capture("agent-step", "query");
  await waitFor("Revenue by customer"); await keys("Escape");
  await capture("agent", "enter accept");
  await focus("h"); await capture("hero", "8 rows");
  await focus("j"); await keys("Tab"); await capture("json", '"name":');
  await keys("Tab"); await capture("record", "row 1 of 8");
  await keys("Tab", "Space", "z"); await capture("zoom", "RESULTS");
  await keys("Space", "z"); await focus("k");
  await keys("G", "o"); await text("select * from cu"); await keys("C-n");
  await waitFor("INSERT"); await capture("editor", "table");
  await keys("Escape", "Escape", "u");
  await keys("Space", "p"); await capture("providers", "Antigravity"); await keys("Escape");
  await keys("Space", "t"); await capture("themes", "follows Omarchy"); await keys("Escape");
  await keys("Space"); await capture("menu", "Help"); await keys("Escape");
  await command("theme omarchy"); await capture("omarchy", "SCHEMA");
  await command("set transparent"); await capture("omarchy-transparent", "SCHEMA", true);
  await command("set notransparent");
  for (const name of ["catppuccin", "nord", "tokyonight"]) {
    await command(`theme ${name}`); await capture(name, "SCHEMA");
  }
  await keys("Space", "a", "a"); await keys("Escape", "Enter"); await capture("agent-accepted", "2 agent");
  // Enter copies the Proposal into a Buffer; Run is an explicit separate action.
  await keys("Space", "a", "a"); await keys("Escape", "r"); await waitFor("8 rows"); await capture("agent-run", "8 rows");
  await tmux("kill-session", "-t", `=${session}`);

  const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? (() => {
    try { return Bun.resolveSync("playwright", root); }
    catch { return Bun.resolveSync("playwright", join(root, "../musy")); }
  })();
  const { chromium } = await import(playwrightPath);
  const chrome = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  browser = chrome;
  const width = 1480, height = 980;
  const page = await chrome.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const font = (await readFile(join(fonts, "JetBrainsMono-latin.woff2"))).toString("base64");
  for (const [name, { ansi, transparent }] of captures) {
    await page.setContent(`<!doctype html><style>
@font-face{font-family:mono;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}
*{box-sizing:border-box}body{margin:0;width:${width}px;height:${height}px;padding:32px;background:radial-gradient(ellipse at 12% 10%,#51404e,transparent 65%),linear-gradient(130deg,#242333,#12141e);color:#c0caf5}
.window{overflow:hidden;border:1px solid #ffffff22;border-radius:14px;box-shadow:0 24px 65px #0009;background:${transparent ? "linear-gradient(125deg,#784d43,#302c48 45%,#234945)" : "#1a1b26"}}
header{height:42px;background:#20212be8;border-bottom:1px solid #ffffff12;position:relative;text-align:center;font:12px mono;color:#9398ae;padding:12px}.dots{position:absolute;left:16px;top:15px;display:flex;gap:8px}.dots i{width:11px;height:11px;border-radius:50%;background:#ff6059}.dots i:nth-child(2){background:#ffbd2e}.dots i:nth-child(3){background:#28c840}
pre{margin:0;padding:16px;font:16px/21px mono;font-variant-ligatures:none;white-space:pre;letter-spacing:0;min-height:872px}span{border-radius:0}
</style><div class="window"><header><div class="dots"><i></i><i></i><i></i></div>losql demo</header><pre>${ansiHtml(ansi)}</pre></div>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(work, `${name}.png`) });
  }
  const statics = ["hero", "editor", "agent", "json", "record", "zoom", "providers", "themes", "menu", "onboarding", "omarchy", "omarchy-transparent"];
  for (const name of statics) {
    await run(["magick", join(work, `${name}.png`), "-quality", "88", join(media, `${name}.webp`)]);
    if (!name.startsWith("omarchy")) await copyFile(join(media, `${name}.webp`), join(root, "readme", `${name}.webp`));
  }
  const sequences: Record<string, string[]> = {
    "workflow-tour": ["hero", "editor", "json", "agent", "themes", "omarchy"],
    "recording-vim": ["hero", "editor", "agent-run", "json", "record", "zoom"],
    "recording-agent": ["agent-open", "agent-question", "agent-step", "agent", "agent-accepted", "agent-run"],
    "recording-omarchy": ["themes", "omarchy", "omarchy-transparent", "catppuccin", "nord", "tokyonight"],
  };
  for (const [name, frames] of Object.entries(sequences)) {
    for (const ext of ["webp", "gif"]) {
      await run(["magick", "-delay", "110", ...frames.map(f => join(work, `${f}.png`)), "-loop", "0", ...(ext === "webp" ? ["-quality", "82"] : []), join(media, `${name}.${ext}`)]);
    }
  }
  const assets: Record<string, { sha256: string; bytes: number; width: number; height: number; animated: boolean; frames: number }> = {};
  const files = [...statics.map(n => `${n}.webp`), ...Object.keys(sequences).flatMap(n => [`${n}.webp`, `${n}.gif`])];
  for (const name of files) {
    const data = await readFile(join(media, name));
    // Inspect the encoded file, not the intended frame count.
    const info = (await run(["magick", "identify", "-format", "%w %h\n", join(media, name)])).trim().split("\n");
    const [w, h] = info[0]!.split(" ").map(Number);
    assets[name] = { sha256: sha(data), bytes: data.length, width: w!, height: h!, animated: info.length > 1, frames: info.length };
    if (name.startsWith("recording-") || name.startsWith("workflow-")) {
      if (info.length < 3) throw new Error(`${name} did not encode as an animation`);
    }
  }
  await writeFile(join(media, "manifest.json"), `${JSON.stringify({ binarySha256, capturedAt: new Date().toISOString(), providerMode: "deterministic local protocol fixtures; real SQLite queries", assets }, null, 2)}\n`);
  console.log(`Wrote ${files.length} assets from binary ${binarySha256}`);
} finally {
  await browser?.close();
  await run(["tmux", "-S", socket, "kill-server"], true);
  // Keep failed captures available for diagnosis when requested.
  if (process.env.CAPTURE_KEEP_WORK) console.log(`Capture work: ${work}`);
  else await rm(work, { recursive: true, force: true });
}
