import { afterEach, describe, expect, test } from "bun:test";
import { createEffect } from "solid-js";
import { mount, type TestApp } from "../testing";

let app: TestApp;
afterEach(async () => {
  await app?.dispose();
});

describe("Fix 1: Help rows are aligned and never cut mid-word", () => {
  test("at 120x36 contains full descriptions, aligns description column, and truncates long keys at 30 cells", async () => {
    app = await mount({ width: 120, height: 36 });
    await app.press("<F1>");

    const collectAllFrames = async () => {
      const frames: string[] = [app.frame()];
      for (let i = 0; i < 40; i++) {
        await app.press("j");
        frames.push(app.frame());
      }
      return frames;
    };

    const defaultFrames = await collectAllFrames();
    const defaultCombined = defaultFrames.join("\n");

    // 1. At 120x36 the frame contains the full descriptions of:
    // - ctrl+w h/j/k/l/w ("focus the Pane to the left, below, above, right, or the next one")
    expect(defaultCombined).toContain("focus the Pane to the left, below, above,");
    expect(defaultCombined).toContain("right, or the next one");
    // - ctrl+n / ctrl+p (insert)
    expect(defaultCombined).toContain("ctrl+n / ctrl+p (insert)");
    expect(defaultCombined).toContain("open completion, next / previous item;");
    expect(defaultCombined).toContain("Enter or Tab accepts, Esc closes");

    // Every help row in the frame has its description starting in the same column
    const firstFrameLines = defaultFrames[0]!.split("\n");
    const descSamples = [
      "focus the Pane to the left, below, above,",
      "right, or the next one",
      "focus the Pane to the left, below, above,",
      "Leader: open the key menu",
      "command line",
      "command palette",
      "help",
    ];
    const cols = descSamples.map((s) => {
      const line = firstFrameLines.find((l) => l.includes(s));
      expect(line).toBeDefined();
      return line!.indexOf(s);
    });
    expect(new Set(cols).size).toBe(1);

    await app.press("q");

    // Register a 28-character key and a >30-character key
    app.api.commands.register({
      id: "test.key28",
      title: "TwentyEightKeyDesc",
      keys: "b cdefghijklmnopqrstuv", // "space b cdefghijklmnopqrstuv" is 28 chars
      run: () => {},
    });
    app.api.commands.register({
      id: "test.key35",
      title: "OverThirtyKeyDesc",
      keys: "c defghijklmnopqrstuvwxyz01234", // "space c defghijklmnopqrstuvwxyz01234" is 36 chars
      run: () => {},
    });

    await app.press("<F1>");
    const customFrames = await collectAllFrames();
    const customCombined = customFrames.join("\n");

    // 28-char key doesn't run into its description, and >30-char key is cut with …
    expect(customCombined).toContain("space b cdefghijklmnopqrstuv   TwentyEightKeyDesc");
    expect(customCombined).toContain("space c defghijklmnopqrstuvwx… OverThirtyKeyDesc");
  });

  test("at 50x14 no key text touches its description and scrolling to the end shows the last row", async () => {
    app = await mount({ width: 50, height: 14 });
    app.api.commands.register({
      id: "test.last",
      title: "Final command at the very bottom",
      ex: ["zzzzlast"],
      run: () => {},
    });

    await app.press("<F1>");
    const topFrame = app.frame();
    // In 50x14, check that "ctrl+w h/j/k/l/w" is separated by at least one space from its description
    const lineWithCtrlW = topFrame.split("\n").find((l) => l.includes("ctrl+w h/j/k/l/w"));
    expect(lineWithCtrlW).toBeDefined();
    expect(lineWithCtrlW).toMatch(/ctrl\+w h\/j\/k\/l\/w\s+focus/);

    // Scroll to the end with G and check the last row is visible (including wrapped continuation if any)
    await app.press("G");
    const bottomFrame = app.frame();
    expect(bottomFrame).toContain(":zzzzlast");
    expect(bottomFrame).toContain("bottom");
  });

  test("at 40x12 scrolls through the dialog with the five longest descriptions intact and no line wider than the terminal", async () => {
    app = await mount({ width: 40, height: 12 });
    await app.press("<F1>");

    const frames: string[] = [app.frame()];
    for (let i = 0; i < 160; i++) {
      const prev = frames[frames.length - 1]!;
      await app.press("j");
      const next = app.frame();
      if (next === prev) break;
      frames.push(next);
    }

    for (const f of frames) {
      for (const line of f.split("\n")) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
      }
    }

    // At 40x12: viewportHeight = 5 (rows 4..8 of the 12-row frame), description starts at col 20..36
    const descRows: string[] = [];
    const firstLines = frames[0]!.split("\n");
    for (let r = 4; r <= 8; r++) {
      descRows.push(firstLines[r]!.slice(20, 36));
    }
    for (let i = 1; i < frames.length; i++) {
      descRows.push(frames[i]!.split("\n")[8]!.slice(20, 36));
    }

    const strippedCombined = descRows.join("").replace(/\s+/g, "");
    const longestFive = [
      "open completion, next / previous item; Enter or Tab accepts, Esc closes",
      "cancel the running Run or Turn; pressed twice within a second, quit",
      "focus the Pane to the left, below, above, right, or the next one",
      "run the selected text, split into Statements and run in order",
      "open the current row as a Record; Esc or q returns",
    ];
    for (const desc of longestFive) {
      expect(strippedCombined).toContain(desc.replace(/\s+/g, ""));
    }
  });

  test("at 30x10 scrolls through the dialog with the five longest descriptions intact and no line wider than the terminal", async () => {
    app = await mount({ width: 30, height: 10 });
    await app.press("<F1>");

    const frames: string[] = [app.frame()];
    for (let i = 0; i < 200; i++) {
      const prev = frames[frames.length - 1]!;
      await app.press("j");
      const next = app.frame();
      if (next === prev) break;
      frames.push(next);
    }

    for (const f of frames) {
      for (const line of f.split("\n")) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
      }
    }

    // At 30x10: viewportHeight = 5 (rows 3..7 of the 10-row frame), description starts at col 13..26
    const descRows: string[] = [];
    const firstLines = frames[0]!.split("\n");
    for (let r = 3; r <= 7; r++) {
      descRows.push(firstLines[r]!.slice(13, 26));
    }
    for (let i = 1; i < frames.length; i++) {
      descRows.push(frames[i]!.split("\n")[7]!.slice(13, 26));
    }

    const strippedCombined = descRows.join("").replace(/\s+/g, "");
    const longestFive = [
      "open completion, next / previous item; Enter or Tab accepts, Esc closes",
      "cancel the running Run or Turn; pressed twice within a second, quit",
      "focus the Pane to the left, below, above, right, or the next one",
      "run the selected text, split into Statements and run in order",
      "open the current row as a Record; Esc or q returns",
    ];
    for (const desc of longestFive) {
      expect(strippedCombined).toContain(desc.replace(/\s+/g, ""));
    }
  });
});

describe("Fix 2: The command line is visible wherever it is active", () => {
  test("with mount({ ui: () => <box /> }), pressing : and typing abc shows :abc in the last row", async () => {
    app = await mount({ ui: () => <box /> });
    await app.press(":abc");
    const lastLine = app.frame().split("\n")[35]!;
    expect(lastLine).toContain(":abc");
  });

  test("with transparent theme, active command line hides the statusline text underneath", async () => {
    app = await mount({ config: { transparent: true } });
    await app.press(":abc");
    const lastLine = app.frame().split("\n")[35]!;
    expect(lastLine).toContain(":abc");
    expect(lastLine).not.toContain("NORMAL");
    expect(lastLine).not.toContain("menu");
  });
});

describe("Fix 3: Replacing an open command line cancels the old one", () => {
  test("opening a second command line while one is active calls the previous onCancel once before opening the new one", async () => {
    app = await mount();
    const events: string[] = [];
    app.api.cmdline.open({
      prefix: "/",
      onSubmit: (t) => events.push(`submit-a:${t}`),
      onCancel: () => events.push("cancel-a"),
    });
    expect(events).toEqual([]);

    app.api.cmdline.open({
      prefix: "?",
      onSubmit: (t) => events.push(`submit-b:${t}`),
      onCancel: () => events.push("cancel-b"),
    });
    expect(events).toEqual(["cancel-a"]);

    await app.press("<Esc>");
    expect(events).toEqual(["cancel-a", "cancel-b"]);
  });
});

describe("Fix 4: Running a Command does not subscribe the caller to the registry", () => {
  test("an effect that calls commands.run or commands.runEx once does not run again when another Command is registered afterwards", async () => {
    let runEffectCount = 0;
    let runExEffectCount = 0;

    app = await mount({
      ui: (api) => {
        api.commands.register({
          id: "test.noop",
          title: "Noop",
          ex: ["noop"],
          run: () => {},
        });
        createEffect(() => {
          runEffectCount++;
          void api.commands.run("test.noop");
        });
        createEffect(() => {
          runExEffectCount++;
          void api.commands.runEx("noo");
        });
        return <box />;
      },
    });

    expect(runEffectCount).toBe(1);
    expect(runExEffectCount).toBe(1);

    app.api.commands.register({
      id: "test.another",
      title: "Another",
      ex: ["another"],
      run: () => {},
    });
    await app.settle();

    expect(runEffectCount).toBe(1);
    expect(runExEffectCount).toBe(1);
  });
});

describe("Fix 6: The key menu fits its terminal", () => {
  test("41 top-level entries at 100 by 20 show … on long titles and a … N more line", async () => {
    app = await mount({ width: 100, height: 20 });
    const keys = "0123456789abcdABCDfghijklmnopqrstuvwxyz"; // 39 keys + 2 existing ("?" and "e") = 41 top-level entries
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      app.api.commands.register({
        id: `test.km.${i}`,
        title:
          i === 0
            ? "An extremely long command title that exceeds the column width easily"
            : `Item ${i}`,
        keys: k,
        run: () => {},
      });
    }

    await app.press("<Space>");
    const frame = app.frame();
    const lines = frame.split("\n");

    // Long title should be cut with …
    expect(frame).toContain("…");
    expect(frame).not.toContain("exceeds the column width");

    // Last visible cell row of the panel ends with … N more
    expect(frame).toMatch(/… \d+ more/);

    // Panel never takes more than terminal height - 2 rows (18 rows)
    const statusLine = lines[19]!;
    expect(statusLine).toContain("NORMAL");
  });

  test("slides up over 100 ms with animations on and jumps immediately when animations are off", async () => {
    app = await mount({ animations: true });
    await app.press("<Space>");

    const rowOfHelp = () => app.frame().split("\n").findIndex((l) => l.includes("Help"));
    const rowAt0 = rowOfHelp();
    expect(rowAt0).toBeGreaterThan(0);

    await app.advance(100);
    const rowAt100 = rowOfHelp();
    expect(rowAt100).toBeGreaterThan(0);
    expect(rowAt0).not.toBe(rowAt100);
    expect(rowAt0).toBe(rowAt100 + 1);

    await app.dispose();

    app = await mount({ animations: false });
    await app.press("<Space>");
    expect(rowOfHelp()).toBe(rowAt100);
  });
});

describe("Fix 7: The Leader key is not swallowed when it has nothing to show", () => {
  test("when leaderTree is empty for the current context, pressing the Leader key reaches a later global handler", async () => {
    const seen: string[] = [];

    app = await mount({
      ui: (api) => {
        // Registered inside ui(api), so in KeysProvider's LIFO globals list this runs AFTER AppShell's global handler
        api.keys.addGlobal((key) => {
          seen.push(key.name);
          return true;
        });
        return <box />;
      },
    });

    // When Leader commands are available, AppShell's global handler consumes <Space> and opens KeyMenu
    await app.press("<Space>");
    expect(seen).toEqual([]);
    await app.press("<Esc>");

    // Make all Leader commands unavailable for the current context
    app.api.commands.register({
      id: "test.hide.help",
      title: "Hidden help",
      keys: "?",
      when: () => false,
      run: () => {},
    });
    app.api.commands.register({
      id: "test.hide.schema",
      title: "Hidden schema",
      keys: "e",
      when: () => false,
      run: () => {},
    });
    const origLeaderTree = app.api.commands.registry.leaderTree.bind(app.api.commands.registry);
    app.api.commands.registry.leaderTree = () => [];
    expect(app.api.commands.registry.leaderTree(app.api)).toEqual([]);

    await app.press("<Space>");
    expect(seen).toEqual(["space"]);
    expect(app.frame()).not.toContain("Help");
    app.api.commands.registry.leaderTree = origLeaderTree;
  });
});

describe("Fix 8: Ex errors say what happened", () => {
  test("ambiguous prefix reports Ambiguous command with at most five names", async () => {
    app = await mount();
    for (let i = 1; i <= 7; i++) {
      app.api.commands.register({
        id: `test.ambig.${i}`,
        title: `Ambig ${i}`,
        ex: [`ambig${i}`],
        run: () => {},
      });
    }

    await app.press(":ambig<CR>");
    expect(app.api.status.message()).toEqual({
      text: "Ambiguous command: ambig (ambig1, ambig2, ambig3, ambig4, ambig5)",
      kind: "error",
    });
  });

  test("a Command whose when is false reports Not available here: <name>", async () => {
    app = await mount();
    app.api.commands.register({
      id: "test.unavail",
      title: "Unavailable",
      ex: ["unavailable", "unav"],
      when: () => false,
      run: () => {},
    });

    await app.press(":unav<CR>");
    expect(app.api.status.message()).toEqual({
      text: "Not available here: unavailable",
      kind: "error",
    });
  });

  test(":set maxrows=<n> accepts 1 to 1,000,000 and rejects values outside that range", async () => {
    app = await mount();
    await app.press(":set maxrows=1<CR>");
    expect(app.api.config.config().results.maxRows).toBe(1);

    await app.press(":set maxrows=1000000<CR>");
    expect(app.api.config.config().results.maxRows).toBe(1000000);

    await app.press(":set maxrows=0<CR>");
    expect(app.api.status.message()).toEqual({
      text: "Invalid value for maxrows: 0",
      kind: "error",
    });
    expect(app.api.config.config().results.maxRows).toBe(1000000);

    await app.press(":set maxrows=1000001<CR>");
    expect(app.api.status.message()).toEqual({
      text: "Invalid value for maxrows: 1000001",
      kind: "error",
    });
    expect(app.api.config.config().results.maxRows).toBe(1000000);
  });
});

describe("Fix 10: Statusline in a narrow terminal", () => {
  test("at 30 and 40 columns no two segments overlap, the mode text is intact, and the hint is absent", async () => {
    for (const width of [30, 40]) {
      app = await mount({ width, height: 24 });
      app.api.status.register("editor", () => ({
        mode: "NORMAL",
        pending: "g",
        position: "12:34",
      }));
      await app.api.session.run({ statements: ["SELECT 1, 2"] });
      await app.settle();

      const lastRow = app.frame().split("\n")[23]!;
      expect(lastRow).toContain(" NORMAL ");
      expect(lastRow).toContain("demo · sqlite");
      expect(lastRow).not.toContain("menu");
      expect(lastRow).not.toContain(": command");
      await app.dispose();
    }
  });
});









