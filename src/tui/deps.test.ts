import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realDeps } from "./deps";

// The real `watch` of realDeps(), on directories of the test's own. A theme switch of Omarchy removes the
// directory that holds colors.toml and moves another one into its place; the watch must keep following.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`not within ${timeoutMs} ms`);
    await sleep(10);
  }
}

describe("realDeps().watch", () => {
  let root: string;
  let themeDir: string;
  let file: string;
  let unwatch: (() => void) | null = null;
  let seen: string[];
  let calls: number;

  const contents = async () => {
    try {
      return await Bun.file(file).text();
    } catch {
      return "<missing>";
    }
  };

  const start = () => {
    unwatch = realDeps().watch(file, () => {
      calls++;
      void contents().then((text) => seen.push(text));
    });
  };

  // What omarchy-theme-set does: build the next theme beside it, remove the current one, move the next one in.
  const switchTo = async (text: string, gapMs: number) => {
    const next = join(root, "next-theme");
    await mkdir(next, { recursive: true });
    await writeFile(join(next, "colors.toml"), text);
    await rm(themeDir, { recursive: true, force: true });
    if (gapMs > 0) await sleep(gapMs);
    await rename(next, themeDir);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "losql-watch-"));
    themeDir = join(root, "current", "theme");
    file = join(themeDir, "colors.toml");
    await mkdir(themeDir, { recursive: true });
    await writeFile(file, "one");
    seen = [];
    calls = 0;
  });

  afterEach(async () => {
    unwatch?.();
    unwatch = null;
    await rm(root, { recursive: true, force: true });
  });

  test("an edit of the file in place is followed", async () => {
    start();
    await sleep(50);
    await writeFile(file, "two");
    await until(() => seen.at(-1) === "two", 1000);
  });

  test("three switches in a row by remove-and-move are each followed", async () => {
    start();
    await sleep(50);
    let n = 0;
    for (const gap of [0, 30, 300]) {
      const text = `switch ${++n} after a gap of ${gap} ms`;
      await switchTo(text, gap);
      await until(() => seen.at(-1) === text, 1000);
    }
    // Nothing was reported while the file was missing.
    expect(seen).not.toContain("<missing>");
  });

  test("a file missing for a second is followed again when it is back", async () => {
    start();
    await sleep(50);
    await rm(themeDir, { recursive: true, force: true });
    await sleep(1000);
    expect(calls).toBe(0);
    await mkdir(themeDir, { recursive: true });
    await writeFile(file, "back");
    await until(() => seen.at(-1) === "back", 1000);
  });

  test("several changes in quick succession lead to one call for the final state", async () => {
    start();
    await sleep(50);
    for (let i = 1; i <= 5; i++) {
      await writeFile(file, `burst ${i}`);
      await sleep(10);
    }
    await until(() => calls > 0, 1000);
    await sleep(600);
    expect(calls).toBe(1);
    expect(seen).toEqual(["burst 5"]);
  });

  test("after unwatch a change calls nothing", async () => {
    start();
    await sleep(50);
    unwatch!();
    unwatch = null;
    await writeFile(file, "two");
    await switchTo("three", 0);
    await sleep(800);
    expect(calls).toBe(0);
  });

  test("after unwatch nothing is left running: the process ends by itself", async () => {
    const script = join(root, "probe.ts");
    await writeFile(
      script,
      [
        `import { realDeps } from ${JSON.stringify(join(import.meta.dir, "deps.ts"))};`,
        `const stop = realDeps().watch(${JSON.stringify(file)}, () => {});`,
        `setTimeout(() => { stop(); console.log("unwatched"); }, 300);`,
      ].join("\n"),
    );
    const child = Bun.spawn([process.execPath, script], {
      cwd: root,
      env: { HOME: root, PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 5000);
    const code = await child.exited;
    clearTimeout(timer);
    expect(await new Response(child.stdout).text()).toBe("unwatched\n");
    expect(child.signalCode).toBeNull();
    expect(code).toBe(0);
  });
});
