import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mount, type TestApp } from "./testing";

let app: TestApp;
afterEach(async () => {
  await app?.dispose();
});

describe("final-c2 fix 3: a bad state file and an unreadable config file give a warning at start", () => {
  test("a state file that is not JSON: one warning toast naming the file, and the first state change keeps the original as .bad", async () => {
    app = await mount({
      connection: null,
      seed: async (deps) => {
        await writeFile(deps.paths.stateFile, "garbage{");
      },
    });
    await app.settle();
    const file = app.deps.paths.stateFile;
    const naming = app.api.toast.items().filter((t) => t.message.includes(file));
    expect(naming.length).toBe(1);
    expect(naming[0]!.kind).toBe("warning");
    expect(await readFile(file, "utf8")).toBe("garbage{");

    await app.api.config.setState({ lastConnection: "dev" });
    expect(await readFile(`${file}.bad`, "utf8")).toBe("garbage{");
    expect((await stat(`${file}.bad`)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).lastConnection).toBe("dev");
    await app.settle();
    expect(app.api.toast.items().filter((t) => t.message.includes(file)).length).toBe(1);
  });

  test("a good state file gives no warning", async () => {
    app = await mount();
    await app.settle();
    expect(app.api.toast.items().filter((t) => t.message.includes(app.deps.paths.stateFile))).toEqual([]);
  });

  test("a directory in the place of config.json: one warning toast naming the file", async () => {
    app = await mount({
      seed: async (deps) => {
        await rm(deps.paths.configFile);
        await mkdir(deps.paths.configFile);
      },
    });
    await app.settle();
    const naming = app.api.toast.items().filter((t) => t.message.includes(app.deps.paths.configFile));
    expect(naming.length).toBe(1);
    expect(naming[0]!.kind).toBe("warning");
  });
});
