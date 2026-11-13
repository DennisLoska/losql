import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../../core/exec";
import { toHex } from "../../core/theme/color";
import { fakeClaude, mount, transparentRatio, type FakeReply, type MountOptions, type TestApp } from "../testing";
import { openModels } from "./model";
import { isValidModelName, quitCancelCount } from "./shared";
import { DATA_NOTICE, openProviders, testProvider } from "./provider";
import { openThemes } from "./theme";

let app: TestApp;
let fake: ReturnType<typeof fakeClaude>;
afterEach(async () => { await app?.dispose(); });

async function start(replies: FakeReply[] = ["ok"], options: MountOptions = {}) {
  fake = fakeClaude(replies);
  app = await mount({ ...options, deps: { which: fake.which, exec: fake.exec, ...options.deps } });
  await app.waitFor(() => app.api.agent.providers().length === 4);
}
const savedConfig = async () => JSON.parse(await Bun.file(app.deps.paths.configFile).text());
const agentConfig = () => app.api.config.config().agent;

describe("the Provider dialog", () => {
  test("lists the four Providers with what was detected", async () => {
    await start();
    await app.press("<Space>p");
    for (const text of [
      "Choose your agent", "Claude Code", "9.9.9", "/fake/bin/claude", "Codex", "not found", "npm install -g @openai/codex",
      "OpenCode", "Antigravity", "Continue without an agent",
    ]) {
      expect(app.frame()).toContain(text);
    }
    expect(DATA_NOTICE).toContain("50 rows");
    expect(app.frame()).toContain(DATA_NOTICE.split(". ")[0]!.slice(0, 40));
  });

  test("choosing a Provider picks a Model, tests it and saves", async () => {
    await start(["ok"]);
    await app.press("<Space>p");
    await app.press("<CR>");
    for (const text of ["Choose a model", "default", "fable", "opus", "sonnet", "haiku"]) expect(app.frame()).toContain(text);
    await app.press("sonnet<CR>");
    await app.waitFor(() => agentConfig().provider === "claude");
    expect(agentConfig().model).toBe("sonnet");
    expect((await savedConfig()).agent).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(fake.requests[0]!.cmd).toContain("sonnet");
    expect(fake.prompts[0]).toBe("Reply with the single word: ok");
    await app.waitFor(() => app.api.dialog.depth() === 0);
    expect(app.api.config.state().providerTests.claude).toMatchObject({ ok: true });
    expect(app.api.toast.items().some((t) => t.kind === "success" && t.message.includes("Claude Code is ready"))).toBe(true);
    expect(app.frame()).toContain("claude · sonnet");
    expect(app.api.agent.provider()?.id).toBe("claude");
  });

  test("the default Model is saved as null and sends no model argument", async () => {
    await start(["ok"]);
    await app.press("<Space>p");
    await app.press("<CR>");
    await app.press("<CR>");
    await app.waitFor(() => agentConfig().provider === "claude");
    expect(agentConfig().model).toBeNull();
    expect(fake.requests[0]!.cmd).not.toContain("--model");
  });

  test("a typed Model name can be used", async () => {
    await start(["ok"]);
    await app.press("<Space>p");
    await app.press("<CR>");
    await app.press("my-custom-model<CR>");
    await app.waitFor(() => agentConfig().provider === "claude");
    expect(agentConfig().model).toBe("my-custom-model");
  });

  test("a failed test explains itself and can be retried", async () => {
    await start([{ error: "You've hit your usage limit" }, "ok"]);
    await app.press("<Space>p");
    await app.press("<CR>");
    await app.press("<CR>");
    await app.waitFor(() => app.frame().includes("did not answer"));
    expect(app.frame()).toContain("usage limit");
    expect(app.frame()).toContain("Try again");
    expect(app.frame()).toContain("Use it anyway");
    expect(agentConfig().provider).toBeNull();
    await app.press("<CR>");
    await app.waitFor(() => agentConfig().provider === "claude");
    expect(app.api.config.state().providerTests.claude).toMatchObject({ ok: true });
  });

  test("a Provider can be kept although its test failed", async () => {
    await start([{ error: "Not logged in. Run claude login." }]);
    await app.press("<Space>p");
    await app.press("<CR>");
    await app.press("<CR>");
    await app.waitFor(() => app.frame().includes("did not answer"));
    expect(app.frame()).toContain("Run `claude` once in a terminal to log in");
    await app.press("anyway<CR>");
    await app.waitFor(() => agentConfig().provider === "claude");
    expect(app.api.config.state().providerTests.claude).toMatchObject({ ok: false });
  });

  test("Providers that are not installed cannot be chosen", async () => {
    await start();
    await app.press("<Space>p");
    await app.press("<C-n><CR>");
    await app.waitFor(() => agentConfig().provider === null && app.api.dialog.depth() === 0);
    expect((await savedConfig()).agent.provider).toBeNull();
  });

  test("Continue without an agent clears the Provider", async () => {
    await start(["ok"], { config: { agent: { provider: "claude", model: "opus" } } });
    await app.press(":provider<CR>");
    expect(app.frame()).toContain("●");
    await app.press("continue<CR>");
    await app.waitFor(() => agentConfig().provider === null);
    expect(agentConfig().model).toBeNull();
    expect(app.frame()).toContain("no agent");
  });

  test("Escape changes nothing, at either level", async () => {
    await start(["ok"]);
    await app.press("<Space>p");
    await app.press("<CR>");
    await app.press("<Esc>");
    expect(app.frame()).toContain("Choose your agent");
    await app.press("<Esc>");
    expect(app.api.dialog.depth()).toBe(0);
    expect(agentConfig().provider).toBeNull();
    expect(fake.requests).toEqual([]);
  });

  test("Models are read from the CLI for OpenCode", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (request) => {
      calls.push(request.cmd);
      const base = { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
      if (request.cmd.includes("--version")) return { ...base, stdout: "2.2.7\n" };
      if (request.cmd[1] === "models") return { ...base, stdout: "acme/small\nacme/large\n" };
      request.onStdoutLine?.(JSON.stringify({ type: "text", part: { text: "ok" } }));
      return base;
    };
    app = await mount({ deps: { which: (bin) => (bin === "opencode" ? "/fake/bin/opencode" : null), exec } });
    await app.waitFor(() => app.api.agent.providers().length === 4);
    await app.press("<Space>p");
    await app.press("opencode<CR>");
    await app.waitFor(() => app.frame().includes("acme/large"));
    await app.press("large<CR>");
    await app.waitFor(() => agentConfig().provider === "opencode");
    expect(agentConfig().model).toBe("acme/large");
    expect(calls.some((cmd) => cmd.includes("-m") && cmd.includes("acme/large"))).toBe(true);
  });

  test("dismissing while a Provider test runs aborts the CLI process and saves nothing", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    await start([{ hold, reply: "ok" }]);
    const p = openProviders(app.api, { step: "Step 2 of 3" });
    await app.settle();
    expect(app.frame()).toContain("Step 2 of 3 · Choose your agent");
    await app.press("<CR>");
    await app.press("<CR>");
    await app.waitFor(() => app.frame().includes("Testing Claude Code…"));
    expect(fake.requests.length).toBe(1);
    const signal = fake.requests[0]!.signal;
    expect(signal?.aborted).toBe(false);
    await app.press("<Esc>");
    expect(signal?.aborted).toBe(true);
    expect(await p).toBeNull();
    release();
    await app.settle();
    expect(agentConfig().provider).toBeNull();
    expect(app.api.toast.items()).toEqual([]);
  });

  test("Choose another and Escape on a failed test return to the Provider list", async () => {
    await start([{ error: "first\x07error\nline two" }]);
    await app.press("<Space>p");
    await app.press("<CR>");
    await app.press("<CR>");
    await app.waitFor(() => app.frame().includes("did not answer"));
    expect(app.frame()).toContain("first\ufffderror");
    expect(app.frame()).toContain("line two");
    await app.press("another<CR>");
    expect(app.frame()).toContain("Choose your agent");
    expect(app.api.dialog.depth()).toBe(1);
    await app.press("<CR>");
    await app.press("<CR>");
    await app.waitFor(() => app.frame().includes("did not answer"));
    await app.press("<Esc>");
    expect(app.frame()).toContain("Choose your agent");
    expect(app.api.dialog.depth()).toBe(1);
  });

  test("testProvider times with the clock and aborts on quit", async () => {
    const never = new Promise<void>(() => {});
    await start(["ok", { hold: never, reply: "ok" }]);
    const okRes = await testProvider(app.api, "claude", null);
    expect(okRes).toEqual({ ok: true, message: "replied in 0.0s" });

    const badModel = await testProvider(app.api, "claude", "-bad");
    expect(badModel.ok).toBe(false);
    expect(badModel.message).toContain("Not a model name");

    const held = testProvider(app.api, "claude", null);
    await app.waitFor(() => fake.requests.length === 2);
    const signal = fake.requests[1]!.signal;
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    await app.api.quit();
    expect(app.deps.exits).toEqual([0]);
    expect(signal!.aborted).toBe(true);
    expect((await held).ok).toBe(false);
  });

  test("shows all four Provider titles whole and shortens the home directory to ~/ while passing the real path to exec", async () => {
    const home = "/home/someone";
    const paths: Record<string, string> = {
      claude: `${home}/.local/share/mise/command-wrappers/versions/2.1.322/bin/claude`,
      codex: `${home}/.local/share/mise/command-wrappers/versions/0.167.2/bin/codex`,
      opencode: `${home}/.local/share/mise/installs/opencode-cli/version-2.2.7/opencode`,
      antigravity: `${home}/.local/share/mise/installs/antigravity-cli/1.5.6/bin/antigravity`,
    };
    const versions: Record<string, string> = {
      [paths.claude!]: "2.1.322\n",
      [paths.codex!]: "0.167.2\n",
      [paths.opencode!]: "2.2.7\n",
      [paths.antigravity!]: "1.5.6\n",
    };
    const testCalls: string[][] = [];
    const exec: Exec = async (request) => {
      const base = { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
      if (request.cmd.includes("--version")) {
        return { ...base, stdout: versions[request.cmd[0]!] ?? "1.0.0\n" };
      }
      testCalls.push(request.cmd);
      request.onStdoutLine?.(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }));
      request.onStdoutLine?.(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }));
      return base;
    };
    app = await mount({
      width: 140,
      height: 40,
      deps: {
        env: { HOME: home },
        which: (bin) => paths[bin] ?? null,
        exec,
      },
    });
    await app.waitFor(() => app.api.agent.providers().length === 4);
    await app.press("<Space>p");

    const frame = app.frame();
    const lines = frame.split("\n");
    for (const label of ["Claude Code", "Codex", "OpenCode", "Antigravity"]) {
      const row = lines.find((l) => l.includes(label));
      expect(row).toBeDefined();
      expect(row).toContain("~/");
      expect(row).not.toContain(home);
    }

    await app.press("<CR>");
    await app.press("<CR>");
    await app.waitFor(() => agentConfig().provider === "claude");
    expect(testCalls.length).toBeGreaterThanOrEqual(1);
    expect(testCalls[0]![0]).toBe(paths.claude);
  });
});

describe("the Model dialog", () => {
  test("changes the Model of the configured Provider without a test", async () => {
    await start(["ok"], { config: { agent: { provider: "claude", model: "opus" } } });
    await app.press("<Space>m");
    expect(app.frame()).toContain("Choose a model");
    expect(app.frame()).toContain("●");
    await app.press("haiku<CR>");
    await app.waitFor(() => agentConfig().model === "haiku");
    expect(fake.requests).toEqual([]);
    await app.press(":model<CR>");
    expect(app.api.dialog.depth()).toBe(1);
  });

  test("without a Provider it opens the Provider dialog", async () => {
    await start();
    await app.press("<Space>m");
    expect(app.frame()).toContain("Choose your agent");
  });

  test("refuses invalid Model names from the CLI or typed by the user", async () => {
    const exec: Exec = async (request) => {
      const base = { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
      if (request.cmd.includes("--version")) return { ...base, stdout: "2.2.7\n" };
      if (request.cmd[1] === "models") {
        return { ...base, stdout: "-flag\nhas space\nbad\x07char\nvalid-model\n" };
      }
      return base;
    };
    app = await mount({
      config: { agent: { provider: "opencode", model: null } },
      deps: { which: (bin) => (bin === "opencode" ? "/fake/bin/opencode" : null), exec },
    });
    await app.waitFor(() => app.api.agent.providers().length === 4);
    await app.press("<Space>m");
    await app.waitFor(() => app.frame().includes("valid-model"));
    expect(app.frame()).not.toContain("-flag");
    expect(app.frame()).not.toContain("has space");
    expect(app.frame()).not.toContain("bad\ufffdchar");

    await app.press("-injected<CR>");
    expect(app.api.status.message()).toEqual({ text: "Not a model name: -injected", kind: "error" });
    expect(agentConfig().model).toBeNull();
  });

  test("dismissing while Models load aborts the CLI call and resolves null", async () => {
    let modelSignal: AbortSignal | undefined;
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const exec: Exec = async (request) => {
      const base = { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
      if (request.cmd.includes("--version")) return { ...base, stdout: "2.2.7\n" };
      if (request.cmd[1] === "models") {
        modelSignal = request.signal;
        await hold;
        return { ...base, stdout: "acme/large\n" };
      }
      return base;
    };
    app = await mount({
      config: { agent: { provider: "opencode", model: null } },
      deps: { which: (bin) => (bin === "opencode" ? "/fake/bin/opencode" : null), exec },
    });
    await app.waitFor(() => app.api.agent.providers().length === 4);
    const p = openModels(app.api, "opencode");
    await app.settle();
    expect(app.frame()).toContain("Loading models…");
    expect(modelSignal?.aborted).toBe(false);
    await app.press("<Esc>");
    expect(modelSignal?.aborted).toBe(true);
    expect(await p).toBeNull();
    release();
    await app.settle();
    expect(app.api.dialog.depth()).toBe(0);
  });
});

describe("the Theme dialog", () => {
  test("previews while moving, restores on Escape and saves on Enter", async () => {
    await start();
    const before = toHex(app.api.theme.theme().background);
    await app.press("<Space>t");
    for (const text of ["Themes", "tokyonight", "catppuccin", "gruvbox", "nord", "rosepine", "everforest", "kanagawa", "●"]) {
      expect(app.frame()).toContain(text);
    }
    await app.press("nord");
    await app.waitFor(() => toHex(app.api.theme.theme().background) !== before);
    expect(app.api.theme.name()).toBe("tokyonight");
    await app.press("<Esc>");
    await app.waitFor(() => toHex(app.api.theme.theme().background) === before);
    await app.press("<Space>t");
    await app.press("gruvbox<CR>");
    await app.waitFor(() => app.api.theme.name() === "gruvbox");
    expect((await savedConfig()).theme).toBe("gruvbox");
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("ctrl+t toggles Transparent and keeps the dialog open", async () => {
    await start();
    await app.press(":theme<CR>");
    expect(app.frame()).toContain("transparent: off");
    await app.press("<C-t>");
    await app.waitFor(() => app.api.config.config().transparent);
    expect(app.frame()).toContain("transparent: on");
    expect(app.api.dialog.depth()).toBe(1);
    expect(transparentRatio(app.spans())).toBeGreaterThan(0.3);
  });

  test("omarchy is listed first when its colour file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "losql-omarchy-"));
    const file = join(dir, "colors.toml");
    await Bun.write(file, 'background = "#101010"\nforeground = "#eeeeee"\naccent = "#ff8800"\n');
    await start(["ok"], { deps: { env: { LOSQL_OMARCHY_COLORS: file } } });
    await app.press("<Space>t");
    const frame = app.frame();
    expect(frame.indexOf("omarchy")).toBeGreaterThan(-1);
    expect(frame.indexOf("omarchy")).toBeLessThan(frame.indexOf("catppuccin"));
    await app.press("omarchy<CR>");
    await app.waitFor(() => app.api.theme.name() === "omarchy");
    expect(toHex(app.api.theme.theme().primary)).toBe("#ff8800");
    await rm(dir, { recursive: true, force: true });
  });

  test("preselect previews immediately, restores on Escape, and duplicate opens do not stack", async () => {
    await start();
    const before = toHex(app.api.theme.theme().background);
    const p1 = openThemes(app.api, { step: "Step 3 of 3", preselect: "nord" });
    const p2 = openThemes(app.api, { step: "Step 3 of 3", preselect: "nord" });
    expect(p1).toBe(p2);
    await app.waitFor(() => toHex(app.api.theme.theme().background) !== before);
    expect(app.frame()).toContain("Step 3 of 3 · Pick a look");
    expect(app.api.dialog.depth()).toBe(1);
    await app.press("<Esc>");
    expect(await p1).toBeNull();
    await app.waitFor(() => toHex(app.api.theme.theme().background) === before);
  });
});

function opencodeExec(models: (() => Promise<Awaited<ReturnType<Exec>>>) | string): Exec {
  return async (request) => {
    const base = { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
    if (request.cmd.includes("--version")) return { ...base, stdout: "2.2.7\n" };
    if (request.cmd[1] === "models") return typeof models === "string" ? { ...base, stdout: models } : models();
    request.onStdoutLine?.(JSON.stringify({ type: "text", part: { text: "ok" } }));
    return base;
  };
}

async function startOpencode(exec: Exec, options: MountOptions = {}) {
  app = await mount({
    config: { agent: { provider: "opencode", model: null } },
    ...options,
    deps: { which: (bin) => (bin === "opencode" ? "/fake/bin/opencode" : null), exec, ...options.deps },
  });
  await app.waitFor(() => app.api.agent.providers().length === 4);
}

/** Turns a file into a non-empty directory so that writing it fails. */
async function makeUnwritable(file: string) {
  await rm(file, { force: true });
  await mkdir(join(file, "blocker"), { recursive: true });
}

describe("Task 22 review: a notice never pushes a dialog's content off screen", () => {
  const sizes = [[80, 24], [60, 16], [40, 12]] as const;
  const messages: Record<string, string> = {
    "100 lines": Array.from({ length: 100 }, (_, i) => `err-line-${i + 1}: details about failure`).join("\n"),
    "one line of 100,000 characters": `ERR_START_${"x".repeat(100_000)}`,
    "100 lines with advice": `You've hit your usage limit\n${Array.from({ length: 100 }, (_, i) => `quota-line-${i + 1}`).join("\n")}`,
  };

  for (const [name, message] of Object.entries(messages)) {
    test(`the failed-test dialog with a message of ${name} keeps the title and all three options`, async () => {
      await start([{ error: message }]);
      await app.press("<Space>p");
      await app.press("<CR>");
      await app.press("<CR>");
      await app.waitFor(() => app.frame().includes("did not answer"));
      for (const [w, h] of sizes) {
        await app.resize(w, h);
        const frame = app.frame();
        for (const text of ["Claude Code did not answer", "Try again", "Choose another", "Use it anyway", message.slice(0, 10), "…"]) {
          expect(frame).toContain(text);
        }
        for (const line of frame.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(w);
      }
    });
  }

  test("a short failure message is shown whole", async () => {
    const message = "The service answered with an error that is a bit longer than one row of the dialog would hold at this width";
    await start([{ error: message }]);
    await app.press("<Space>p");
    await app.press("<CR>");
    await app.press("<CR>");
    await app.waitFor(() => app.frame().includes("did not answer"));
    const frame = app.frame();
    for (const word of message.split(" ")) expect(frame).toContain(word);
    expect(frame).toContain("at this width");
    for (const line of frame.split("\n").filter((l) => l.includes("service") || l.includes("width"))) {
      expect(line).not.toContain("…");
    }
  });
});

describe("Task 22 review: a save that failed is not reported as a choice", () => {
  test("a failing config.set resolves null, keeps the configuration and says what could not be saved", async () => {
    await start(["ok"], { config: { agent: { provider: "opencode", model: "prev-model" } } });
    app.api.config.set = async () => {
      throw new Error("read-only filesystem");
    };
    const p = openProviders(app.api);
    await app.settle();
    await app.press("claude<CR>");
    await app.waitFor(() => app.frame().includes("Choose a model"));
    await app.press("sonnet<CR>");
    expect(await p).toBeNull();
    expect(agentConfig()).toMatchObject({ provider: "opencode", model: "prev-model" });
    expect(app.api.config.state().providerTests.claude).toBeUndefined();
    expect(app.api.toast.items().some((t) => t.kind === "error" && t.message === "Could not save config: read-only filesystem")).toBe(true);
    expect(app.api.toast.items().some((t) => t.kind === "success")).toBe(false);
    await app.waitFor(() => app.api.dialog.depth() === 0);
  });

  test("a configuration file that cannot be written leaves the configuration in memory as it was", async () => {
    await start(["ok"], { config: { agent: { provider: "opencode", model: "prev-model" } } });
    await makeUnwritable(app.deps.paths.configFile);
    const p = openProviders(app.api);
    await app.settle();
    await app.press("claude<CR>");
    await app.waitFor(() => app.frame().includes("Choose a model"));
    await app.press("sonnet<CR>");
    expect(await p).toBeNull();
    expect(agentConfig()).toMatchObject({ provider: "opencode", model: "prev-model" });
    expect(app.api.toast.items().some((t) => t.kind === "error" && t.message.startsWith("Could not save config: "))).toBe(true);
  });

  test("Continue without an agent with a failing save resolves null and keeps the Provider", async () => {
    await start(["ok"], { config: { agent: { provider: "claude", model: "opus" } } });
    await makeUnwritable(app.deps.paths.configFile);
    const p = openProviders(app.api);
    await app.settle();
    await app.press("continue<CR>");
    expect(await p).toBeNull();
    expect(agentConfig()).toMatchObject({ provider: "claude", model: "opus" });
    expect(app.api.toast.items().some((t) => t.kind === "error" && t.message.startsWith("Could not save config: "))).toBe(true);
  });

  test("a state file that cannot be written resolves null and restores the configuration in memory and on disk", async () => {
    await start(["ok"], { config: { agent: { provider: "opencode", model: "prev-model" } } });
    await makeUnwritable(app.deps.paths.stateFile);
    const p = openProviders(app.api);
    await app.settle();
    await app.press("claude<CR>");
    await app.waitFor(() => app.frame().includes("Choose a model"));
    await app.press("sonnet<CR>");
    expect(await p).toBeNull();
    expect(agentConfig()).toMatchObject({ provider: "opencode", model: "prev-model" });
    expect((await savedConfig()).agent).toMatchObject({ provider: "opencode", model: "prev-model" });
    expect(app.api.config.state().providerTests.claude).toBeUndefined();
    expect(app.api.toast.items().some((t) => t.kind === "error" && t.message.startsWith("Could not save state: "))).toBe(true);
    expect(app.api.toast.items().some((t) => t.kind === "success")).toBe(false);
  });

  test("a failing setState names the state file", async () => {
    await start(["ok"]);
    app.api.config.setState = async () => {
      throw new Error("state dir locked");
    };
    const p = openProviders(app.api);
    await app.settle();
    await app.press("<CR><CR>");
    expect(await p).toBeNull();
    expect(agentConfig()).toMatchObject({ provider: null, model: null });
    expect(app.api.toast.items().some((t) => t.kind === "error" && t.message === "Could not save state: state dir locked")).toBe(true);
  });
});

describe("Task 22 review: the first frame of a select dialog uses the dialog's real width", () => {
  test("the Providers dialog at 140 columns draws the same rows before and after the first measurement", async () => {
    const home = "/home/someone";
    const paths: Record<string, string> = {
      claude: `${home}/.local/share/mise/command-wrappers/versions/2.1.322/bin/claude`,
      codex: `${home}/.local/share/mise/command-wrappers/versions/0.167.2/bin/codex`,
      opencode: `${home}/.local/share/mise/installs/opencode-cli/version-2.2.7/opencode`,
      antigravity: `${home}/.local/share/mise/installs/antigravity-cli/1.5.6/bin/antigravity`,
    };
    const exec: Exec = async (request) => ({ code: 0, stdout: request.cmd.includes("--version") ? "2.1.322\n" : "", stderr: "", timedOut: false, aborted: false });
    app = await mount({ width: 140, height: 40, deps: { env: { HOME: home }, which: (bin) => paths[bin] ?? null, exec } });
    await app.waitFor(() => app.api.agent.providers().length === 4);
    const rowsOf = (frame: string) =>
      frame.split("\n").filter((l) => ["Claude Code", "Codex", "OpenCode", "Antigravity", "Continue without"].some((t) => l.includes(t)));
    void openProviders(app.api);
    await app.setup.renderOnce();
    const first = rowsOf(app.frame());
    await app.settle();
    const settled = rowsOf(app.frame());
    expect(first.length).toBe(5);
    expect(first).toEqual(settled);
  });
});

describe("Task 22 review: Model names", () => {
  const long200 = "k".repeat(200);
  const listing = ["bidi‮abc", "zero​width", "m".repeat(201), "n".repeat(10_000), long200, "valid-model"].join("\n");

  test("names with format characters or longer than 200 characters are not offered", async () => {
    await startOpencode(opencodeExec(listing));
    await app.press("<Space>m");
    await app.waitFor(() => app.frame().includes("valid-model"));
    const frame = app.frame();
    expect(frame).toContain("kkkk");
    expect(frame).not.toContain("bidi");
    expect(frame).not.toContain("zero");
    expect(frame).not.toContain("mmmm");
    expect(frame).not.toContain("nnnn");
  });

  test("names with format characters or longer than 200 characters are refused when typed; 200 characters are accepted", async () => {
    await startOpencode(opencodeExec("valid-model\n"));
    const p = openModels(app.api, "opencode");
    await app.waitFor(() => app.frame().includes("valid-model"));
    for (const bad of ["bidi‮abc", "zero​width", "m".repeat(201), "n".repeat(10_000)]) {
      app.api.keys.paste(bad);
      await app.press("<CR>");
      expect(app.api.dialog.depth()).toBe(1);
      expect(app.frame()).toContain("Not a model name");
      expect(app.api.status.message()?.kind).toBe("error");
      await app.press("<C-u>");
    }
    const typed = "t".repeat(200);
    app.api.keys.paste(typed);
    await app.press("<CR>");
    expect(await p).toBe(typed);
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("a refused typed name keeps the dialog open with the reason and can be corrected", async () => {
    await startOpencode(opencodeExec("valid-model\n"));
    const p = openModels(app.api, "opencode");
    await app.waitFor(() => app.frame().includes("valid-model"));
    await app.press("-bad<CR>");
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.frame()).toContain("Not a model name: -bad");
    expect(app.frame()).toContain("> -bad");
    await app.press("<C-u>good-name<CR>");
    expect(await p).toBe("good-name");
    expect(app.api.dialog.depth()).toBe(0);
  });
});

describe("Task 22 review: a listing that failed says so", () => {
  const NOTICE = "Models could not be listed; you can still type a name";
  const base = { stdout: "", stderr: "", timedOut: false, aborted: false };

  test("a failing CLI shows the notice and the dialog still accepts a typed name", async () => {
    await startOpencode(opencodeExec(async () => ({ ...base, code: 1, stderr: "boom" })));
    const p = openModels(app.api, "opencode");
    await app.waitFor(() => app.frame().includes(NOTICE));
    expect(app.frame()).toContain("default");
    await app.press("acme/typed<CR>");
    expect(await p).toBe("acme/typed");
  });

  test("a timed-out or throwing CLI shows the notice", async () => {
    await startOpencode(opencodeExec(async () => ({ ...base, code: null, timedOut: true })));
    void openModels(app.api, "opencode");
    await app.waitFor(() => app.frame().includes(NOTICE));
    await app.dispose();
    await startOpencode(opencodeExec(async () => { throw new Error("spawn failed"); }));
    void openModels(app.api, "opencode");
    await app.waitFor(() => app.frame().includes(NOTICE));
  });

  test("an empty listing shows no notice", async () => {
    await startOpencode(opencodeExec(""));
    void openModels(app.api, "opencode");
    await app.waitFor(() => app.frame().includes("default"));
    expect(app.frame()).not.toContain("could not be listed");
  });
});

describe("Task 22 review: choosing a Theme that could not be applied is not a choice", () => {
  test("resolves null when select rejects, and the toast stays", async () => {
    await start();
    app.api.theme.select = async () => {
      throw new Error("theme file vanished");
    };
    const p = openThemes(app.api);
    await app.settle();
    await app.press("nord<CR>");
    expect(await p).toBeNull();
    expect(app.api.toast.items().some((t) => t.kind === "error" && t.message.includes("theme file vanished"))).toBe(true);
  });
});

describe("Task 22 review: isValidModelName", () => {
  test("refuses format characters and names longer than 200 characters", () => {
    for (const bad of ["bidi‮abc", "zero​width", "soft­hyphen", "m".repeat(201), "n".repeat(10_000), "-flag", "has space", "bad\x07char", "", " "]) {
      expect(isValidModelName(bad)).toBe(false);
    }
    for (const good of ["k".repeat(200), "😀".repeat(200), "acme/large", "claude-sonnet-4-5", "default"]) {
      expect(isValidModelName(good)).toBe(true);
    }
  });
});

describe("a dialog that failed to open can be opened again", () => {
  /** Makes the next `api.dialog.open` throw once; later calls open as usual. */
  const failOpenOnce = () => {
    const realOpen = app.api.dialog.open;
    let failed = false;
    app.api.dialog.open = (...args) => {
      if (!failed) {
        failed = true;
        throw new Error("cannot open");
      }
      return realOpen(...args);
    };
  };

  const cases: [string, () => Promise<unknown>, string][] = [
    ["the Provider dialog", () => openProviders(app.api), "Choose your agent"],
    ["the Model dialog", () => openModels(app.api, "claude"), "Choose a model"],
    ["the Theme dialog", () => openThemes(app.api), "Themes"],
  ];
  for (const [name, open, title] of cases) {
    test(`${name}: the failed call rejects, leaves no quit hook, and the next call opens it and resolves`, async () => {
      await start();
      const hooksBefore = quitCancelCount(app.api);
      failOpenOnce();
      await expect(open()).rejects.toThrow("cannot open");
      expect(quitCancelCount(app.api)).toBe(hooksBefore);
      expect(app.api.dialog.depth()).toBe(0);

      const second = open();
      await app.settle();
      expect(app.api.dialog.depth()).toBe(1);
      expect(app.frame()).toContain(title);
      expect(quitCancelCount(app.api)).toBe(hooksBefore + 1);
      await app.press("<Esc>");
      expect(await second).toBeNull();
      expect(quitCancelCount(app.api)).toBe(hooksBefore);
    });
  }
});

describe("final-c2 fix 4: a dialog opened from a dialog that fails does not end the program", () => {
  test("the Model dialog fails to open after a Provider was chosen: the Provider dialog stays usable and the status line says why", async () => {
    await start(["ok"]);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const realOpen = app.api.dialog.open;
      let calls = 0;
      app.api.dialog.open = (...args) => {
        if (++calls === 2) throw new Error("the Model dialog cannot open");
        return realOpen(...args);
      };

      await app.press("<Space>p");
      expect(app.frame()).toContain("Choose your agent");
      await app.press("<CR>");
      await app.settle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await app.settle();

      expect(rejections).toEqual([]);
      expect(app.api.status.message()).toEqual({ text: "the Model dialog cannot open", kind: "error" });
      expect(app.api.dialog.depth()).toBe(1);
      expect(app.frame()).toContain("Choose your agent");
      expect(app.frame()).not.toContain("Choose a model");

      await app.press("<CR>");
      await app.waitFor(() => app.frame().includes("Choose a model"));
      expect(app.api.dialog.depth()).toBe(2);
      await app.press("sonnet<CR>");
      await app.waitFor(() => agentConfig().provider === "claude");
      expect(agentConfig().model).toBe("sonnet");
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  /** Runs `body` with a listener for unhandled rejections; returns what reached it. */
  const collectRejections = async (body: () => Promise<void>): Promise<unknown[]> => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await body();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await app.settle();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    return rejections;
  };

  test("a Theme choice whose handling fails: the status line shows the message and nothing is left unhandled", async () => {
    await start();
    let chosen: Promise<string | null> | null = null;
    const rejections = await collectRejections(async () => {
      chosen = openThemes(app.api);
      await app.waitFor(() => app.frame().includes("Themes") && !app.frame().includes("Loading themes"));
      app.api.theme.select = async () => {
        throw new Error("cannot apply");
      };
      const realShow = app.api.toast.show;
      app.api.toast.show = (toast) => {
        if (toast.message.startsWith("Theme could not be saved")) throw new Error("the toast failed");
        return realShow(toast);
      };
      await app.press("<CR>");
    });
    expect(rejections).toEqual([]);
    expect(app.api.status.message()).toEqual({ text: "the toast failed", kind: "error" });
    expect(await chosen!).toBeNull();
  });

  test("a failed detection while the Provider dialog opens leaves nothing unhandled and the dialog usable", async () => {
    await start();
    const rejections = await collectRejections(async () => {
      app.api.agent.detect = async () => {
        throw new Error("detection failed");
      };
      void openProviders(app.api);
      await app.waitFor(() => app.frame().includes("Choose your agent") && app.frame().includes("Claude Code"));
    });
    expect(rejections).toEqual([]);
    expect(app.api.status.message()).toEqual({ text: "detection failed", kind: "error" });
    expect(app.api.dialog.depth()).toBe(1);
  });
});

describe("Provider processes started from the dialogs do not inherit the variables a saved Connection reads its password from", () => {
  const env = { DBPW: "hunter2", PATH: "/usr/bin:/bin", OTHERPW: "later" };
  const savedConnections = [{ name: "saved", url: "postgres://u:${DBPW}@127.0.0.1:54329/x" }];
  const laterConnection = { name: "new", url: "postgres://u:${OTHERPW}@127.0.0.1:54329/y" };

  const expectClean = (seen: Record<string, string | undefined> | undefined) => {
    expect(seen).toBeDefined();
    expect(seen!.DBPW).toBeUndefined();
    expect(seen!.OTHERPW).toBeUndefined();
    expect(seen!.PATH).toBe("/usr/bin:/bin");
  };

  test("the test prompt gets an environment without them, including a Connection saved after the start", async () => {
    await start(["ok"], { config: { connections: savedConnections }, deps: { env } });
    await app.api.config.set((c) => ({ ...c, connections: [...c.connections, laterConnection] }));
    const res = await testProvider(app.api, "claude", null);
    expect(res.ok).toBe(true);
    expect(fake.requests.length).toBe(1);
    expectClean(fake.requests[0]!.env);
  });

  test("the model listing gets an environment without them, including a Connection saved after the start", async () => {
    const listings: (Record<string, string | undefined> | undefined)[] = [];
    const inner = opencodeExec("acme/large\n");
    const exec: Exec = async (request) => {
      if (request.cmd[1] === "models") listings.push(request.env);
      return inner(request);
    };
    await startOpencode(exec, { config: { agent: { provider: "opencode", model: null }, connections: savedConnections }, deps: { env } });
    await app.api.config.set((c) => ({ ...c, connections: [...c.connections, laterConnection] }));
    const p = openModels(app.api, "opencode");
    await app.waitFor(() => app.frame().includes("acme/large"));
    expect(listings.length).toBe(1);
    expectClean(listings[0]);
    await app.press("<Esc>");
    expect(await p).toBeNull();
  });
});
