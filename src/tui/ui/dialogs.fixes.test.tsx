import { TextAttributes } from "@opentui/core";
import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { mount, type TestApp } from "../testing";
import { InputLine } from "./input-line";
import { createLineInput } from "./line-input";
import type { SelectOption } from "./select";


let app: TestApp;
afterEach(async () => {
  await app?.dispose();
});

describe("Fix 2: InputLine keeps the cursor visible and masks per grapheme", () => {
  test("scrolls long text in dialog.prompt to keep the cursor visible and returns to start on <Home>", async () => {
    app = await mount({ ui: () => <text>base</text> });
    void app.api.dialog.prompt({ title: "Connection URL" });
    await app.settle();

    const url = "postgres://user:password@localhost:5432/database_name_that_is_eighty_chars_long_";
    expect(url.length).toBe(80);

    await app.press(url + "ZZEND");
    expect(app.frame()).toContain("ZZEND");
    expect(app.frame()).toContain("…");
    expect(app.frame()).not.toContain("postgres://user");

    await app.press("<Home>");
    expect(app.frame()).toContain("postgres://user");
    expect(app.frame()).toContain("…");
    expect(app.frame()).not.toContain("ZZEND");
  });

  test("masked value of a😀 shows two bullets and cursor draws whole grapheme", async () => {
    app = await mount({ ui: () => <text>base</text> });
    void app.api.dialog.prompt({ title: "Password", mask: true });
    await app.settle();

    app.api.keys.paste("a😀");
    await app.settle();

    expect(app.frame()).toContain("••");
    expect(app.frame()).not.toContain("•••");
    app.api.dialog.clear();
    await app.settle();

    void app.api.dialog.prompt({ title: "Emoji" });
    await app.settle();
    app.api.keys.paste("a😀b");
    await app.settle();
    await app.press("<Left><Left>");
    expect(app.frame()).toContain("a😀b");
  });
});

describe("Fix 4: onMove follows the selection when the filter changes", () => {
  test("fires onMove once when filtering changes the selected option and never when it stays the same", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const options = [
      { title: "Apple", value: "apple" },
      { title: "Banana", value: "banana" },
      { title: "Cherry", value: "cherry" },
      { title: "Blueberry", value: "blueberry" },
    ];
    const moves: (string | null)[] = [];
    void app.api.dialog.select({
      title: "Fruit",
      options,
      onMove: (opt) => moves.push(opt?.value ?? null),
    });
    await app.settle();
    expect(moves).toEqual([]);

    // Typing "b" moves selection from Apple to Banana -> onMove called once with Banana
    await app.press("b");
    expect(moves).toEqual(["banana"]);

    // Typing "a" keeps Banana selected -> onMove is not called
    await app.press("a");
    expect(moves).toEqual(["banana"]);

    // Clearing filter moves selection back from Banana to Apple -> onMove called once with Apple
    await app.press("<C-u>");
    expect(moves).toEqual(["banana", "apple"]);

    // Typing "a" keeps Apple selected -> onMove is not called
    await app.press("a");
    expect(moves).toEqual(["banana", "apple"]);

    // Clearing filter when Apple is already selected -> onMove is not called
    await app.press("<BS>");
    expect(moves).toEqual(["banana", "apple"]);
  });
});

describe("Fix 5: selection follows its option when options change", () => {
  test("keeps the option with the same value selected when reordered, or falls back to first enabled and fires onMove", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const [opts, setOpts] = createSignal<SelectOption<string>[]>([
      { title: "Apple", value: "apple" },
      { title: "Banana", value: "banana" },
      { title: "Cherry", value: "cherry" },
    ]);
    const moves: (string | null)[] = [];
    const picked = app.api.dialog.select({
      title: "Fruit",
      get options() {
        return opts();
      },
      onMove: (opt) => moves.push(opt?.value ?? null),
    });
    await app.settle();

    // Move to Banana (index 1)
    await app.press("<Down>");
    expect(moves).toEqual(["banana"]);

    // Reorder options so Banana is now at index 2 -> Banana stays selected, onMove does not fire
    setOpts([
      { title: "Cherry", value: "cherry" },
      { title: "Apple", value: "apple" },
      { title: "Banana", value: "banana" },
    ]);
    await app.settle();
    expect(moves).toEqual(["banana"]);

    // Disable Banana -> selection moves to first enabled (Cherry) and onMove fires once
    setOpts([
      { title: "Cherry", value: "cherry" },
      { title: "Apple", value: "apple" },
      { title: "Banana", value: "banana", disabled: true },
    ]);
    await app.settle();
    expect(moves).toEqual(["banana", "cherry"]);

    // Move to Apple, then remove Apple -> selection moves to first enabled (Cherry) and onMove fires once
    await app.press("<Down>");
    expect(moves).toEqual(["banana", "cherry", "apple"]);
    setOpts([{ title: "Cherry", value: "cherry" }]);
    await app.settle();
    expect(moves).toEqual(["banana", "cherry", "apple", "cherry"]);

    await app.press("<CR>");
    expect(await picked).toBe("cherry");
  });
});

describe("Fix 6: a failing validate shows its error", () => {
  test("catches a thrown/rejected error from validate, shows its message, keeps dialog usable, and ignores second Enter while pending", async () => {
    app = await mount({ ui: () => <text>base</text> });
    let calls = 0;
    let releaseValidation!: () => void;
    const gate = new Promise<void>((r) => {
      releaseValidation = r;
    });

    const answer = app.api.dialog.prompt({
      title: "Input",
      validate: async (value) => {
        calls++;
        if (calls === 1) {
          await gate;
          throw new Error("boom");
        }
        return value === "ok" ? null : "still bad";
      },
    });
    await app.settle();

    // First Enter starts async validation; second Enter while pending is ignored
    await app.press("<CR><CR>");
    expect(calls).toBe(1);

    releaseValidation();
    await app.waitFor(() => app.frame().includes("boom"));
    expect(app.frame()).toContain("boom");
    expect(app.api.dialog.depth()).toBe(1);

    // Typing still works and clears the error, then submitting succeeds
    await app.press("ok");
    expect(app.frame()).not.toContain("boom");
    await app.press("<CR>");
    expect(await answer).toBe("ok");
  });
});

describe("Fix 7: open dialogs are closed when the dialog provider unmounts", () => {
  test("disposing the app settles pending prompt, select and confirm with their dismissed values", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const promptPromise = app.api.dialog.prompt({ title: "Name" });
    const selectPromise = app.api.dialog.select({
      title: "Pick",
      options: [{ title: "One", value: 1 }],
    });
    const confirmPromise = app.api.dialog.confirm({ title: "Sure?" });
    await app.settle();
    expect(app.api.dialog.depth()).toBe(3);

    await app.dispose();

    const racedPrompt = await Promise.race([
      promptPromise,
      new Promise<string>((r) => setTimeout(() => r("__timed_out__"), 50)),
    ]);
    const racedSelect = await Promise.race([
      selectPromise,
      new Promise<string>((r) => setTimeout(() => r("__timed_out__"), 50)),
    ]);
    const racedConfirm = await Promise.race([
      confirmPromise,
      new Promise<string>((r) => setTimeout(() => r("__timed_out__"), 50)),
    ]);

    expect(racedPrompt).toBeNull();
    expect(racedSelect).toBeNull();
    expect(racedConfirm).toBe(false);
  });
});

describe("Fix 8: text from outside never carries control characters to the screen", () => {
  test("a toast with ESC and BEL renders no ESC and no BEL in app.frame()", async () => {
    app = await mount();
    app.api.toast.show({ message: "\x1b]0;hi\x07red", title: "err\x1b[31m" });
    await app.settle();

    const frame = app.frame();
    expect(frame).not.toContain("\x1b");
    expect(frame).not.toContain("\x07");
    expect(frame).toContain("\ufffd]0;hi\ufffdred");
    // Stored toast keeps original message
    expect(app.api.toast.items()[0]?.message).toBe("\x1b]0;hi\x07red");
  });

  test("status messages and dialog titles/descriptions/options sanitize control characters", async () => {
    app = await mount();
    app.api.status.say("db\x1b[31merr\x07", "error");
    void app.api.dialog.select({
      title: "Title\x1b[2J",
      description: "Desc\x07",
      options: [{ title: "Opt\x1b[0m", value: "v", description: "Sub\x07" }],
    });
    await app.settle();

    const frame = app.frame();
    expect(frame).not.toContain("\x1b");
    expect(frame).not.toContain("\x07");
    expect(frame).toContain("db\ufffd[31merr\ufffd");
    expect(frame).toContain("Title\ufffd[2J");
    expect(frame).toContain("Opt\ufffd[0m");
  });
});

describe("Fix 9: capital answers in confirm dialog", () => {
  test("Y answers true and N answers false", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const first = app.api.dialog.confirm({ title: "Confirm?" });
    await app.settle();
    await app.press("Y");
    expect(await first).toBe(true);

    const second = app.api.dialog.confirm({ title: "Confirm?" });
    await app.settle();
    await app.press("N");
    expect(await second).toBe(false);
  });
});

describe("Round 2 Fix 1: multi-line texts keep their lines", () => {
  test("a toast with a\\nb draws a and b on two rows, and a three-line error keeps three lines", async () => {
    app = await mount({ ui: () => <text>base</text> });
    app.api.toast.show({
      title: "TITLE_L1\nTITLE_L2",
      message: "ROW_A\nROW_B",
      kind: "info",
    });
    app.api.toast.show({
      message: "ERROR: bad\r\nDETAIL: more\rHINT: x",
      kind: "error",
    });
    await app.settle();

    const lines = app.frame().split("\n");
    const rowA = lines.findIndex((l) => l.includes("ROW_A"));
    const rowB = lines.findIndex((l) => l.includes("ROW_B"));
    expect(rowA).toBeGreaterThanOrEqual(0);
    expect(rowB).toBe(rowA + 1);

    const title1 = lines.findIndex((l) => l.includes("TITLE_L1"));
    const title2 = lines.findIndex((l) => l.includes("TITLE_L2"));
    expect(title1).toBeGreaterThanOrEqual(0);
    expect(title2).toBe(title1 + 1);

    const errRow = lines.findIndex((l) => l.includes("ERROR: bad"));
    const detailRow = lines.findIndex((l) => l.includes("DETAIL: more"));
    const hintRow = lines.findIndex((l) => l.includes("HINT: x"));
    expect(errRow).toBeGreaterThanOrEqual(0);
    expect(detailRow).toBe(errRow + 1);
    expect(hintRow).toBe(errRow + 2);
  });

  test("a confirm message with two lines draws two rows", async () => {
    app = await mount({ ui: () => <text>base</text> });
    void app.api.dialog.confirm({
      title: "Delete?",
      message: "CONFIRM_LINE_1\nCONFIRM_LINE_2",
    });
    await app.settle();

    const lines = app.frame().split("\n");
    const r1 = lines.findIndex((l) => l.includes("CONFIRM_LINE_1"));
    const r2 = lines.findIndex((l) => l.includes("CONFIRM_LINE_2"));
    expect(r1).toBeGreaterThanOrEqual(0);
    expect(r2).toBe(r1 + 1);
  });

  test("select and prompt multi-line descriptions and notices draw on multiple rows, while an option title with a newline stays on one row", async () => {
    app = await mount({ ui: () => <text>base</text> });
    void app.api.dialog.select({
      title: "Select",
      description: "SEL_DESC_1\nSEL_DESC_2",
      notice: { text: "SEL_NOTE_1\nSEL_NOTE_2", kind: "info" },
      options: [{ title: "OPT_PART_1\nOPT_PART_2", value: "v" }],
    });
    await app.settle();

    let lines = app.frame().split("\n");
    const d1 = lines.findIndex((l) => l.includes("SEL_DESC_1"));
    const d2 = lines.findIndex((l) => l.includes("SEL_DESC_2"));
    expect(d1).toBeGreaterThanOrEqual(0);
    expect(d2).toBe(d1 + 1);

    const n1 = lines.findIndex((l) => l.includes("SEL_NOTE_1"));
    const n2 = lines.findIndex((l) => l.includes("SEL_NOTE_2"));
    expect(n1).toBeGreaterThanOrEqual(0);
    expect(n2).toBe(n1 + 1);

    const optRow = lines.findIndex((l) => l.includes("OPT_PART_1 OPT_PART_2"));
    expect(optRow).toBeGreaterThanOrEqual(0);

    app.api.dialog.clear();
    await app.settle();

    void app.api.dialog.prompt({
      title: "Prompt",
      description: "PR_DESC_1\nPR_DESC_2",
      validate: () => "ERR_LINE_1\nERR_LINE_2",
    });
    await app.settle();
    await app.press("<CR>");

    lines = app.frame().split("\n");
    const pd1 = lines.findIndex((l) => l.includes("PR_DESC_1"));
    const pd2 = lines.findIndex((l) => l.includes("PR_DESC_2"));
    expect(pd1).toBeGreaterThanOrEqual(0);
    expect(pd2).toBe(pd1 + 1);

    const pe1 = lines.findIndex((l) => l.includes("ERR_LINE_1"));
    const pe2 = lines.findIndex((l) => l.includes("ERR_LINE_2"));
    expect(pe1).toBeGreaterThanOrEqual(0);
    expect(pe2).toBe(pe1 + 1);
  });
});

describe("Round 2 Fix 3: a validation result applies only to the text it validated", () => {
  test("drops a validation error when the user typed while validate was pending", async () => {
    app = await mount({ ui: () => <text>base</text> });
    let resolveValidate!: (res: string | null) => void;
    const answer = app.api.dialog.prompt({
      title: "Input",
      validate: (value) =>
        new Promise<string | null>((resolve) => {
          if (value === "nope") {
            resolveValidate = resolve;
          } else {
            resolve(null);
          }
        }),
    });
    await app.settle();

    await app.press("nope<CR>");
    await app.press("x");
    expect(app.frame()).toContain("nopex");

    resolveValidate("bad_validation_error");
    await app.settle();

    expect(app.frame()).not.toContain("bad_validation_error");
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.frame()).toContain("nopex");

    // Pressing Enter again validates "nopex" and submits
    await app.press("<CR>");
    expect(await answer).toBe("nopex");
  });

  test("drops a passing validation result when the user typed while validate was pending", async () => {
    app = await mount({ ui: () => <text>base</text> });
    let resolveValidate!: (res: string | null) => void;
    let submitted: string | null | undefined;
    const answer = app.api.dialog.prompt({
      title: "Input",
      validate: (value) =>
        new Promise<string | null>((resolve) => {
          if (value === "nope") {
            resolveValidate = resolve;
          } else {
            resolve(null);
          }
        }),
    });
    void answer.then((v) => {
      submitted = v;
    });
    await app.settle();

    await app.press("nope<CR>");
    await app.press("x");

    resolveValidate(null);
    await app.settle();

    expect(submitted).toBeUndefined();
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.frame()).toContain("nopex");

    await app.press("<CR>");
    expect(await answer).toBe("nopex");
  });
});

describe("Round 2 Fix 4: the input line never loses its cursor at narrow widths", () => {
  test("at widths 1, 2 and 3 with ASCII text the frame row is never only ellipsis and shows the cursor cell", async () => {
    for (const w of [1, 2, 3]) {
      const input = createLineInput({ initial: "abcdef" });
      app = await mount({
        ui: () => (
          <box width={w} height={1}>
            <InputLine input={input} width={w} />
          </box>
        ),
      });

      const checkRow = (expectedCursorChar?: string) => {
        const row = app.frame().split("\n")[0]!.slice(0, w);
        expect(row.replace(/…/g, "").length).toBeGreaterThan(0);
        if (expectedCursorChar) {
          expect(row).toContain(expectedCursorChar);
        }
      };

      // At end of text (cursor on blank cell after 'f')
      checkRow(" ");
      const endRow = app.frame().split("\n")[0]!.slice(0, w);
      expect(endRow.endsWith(" ")).toBe(true);

      // Move cursor to start and advance right onto 'd' (typing/moving right, both sides cut)
      input.set("abcdef", 0);
      await app.settle();
      input.set("abcdef", 3);
      await app.settle();
      checkRow("d");
      const midRow = app.frame().split("\n")[0]!.slice(0, w);
      if (w === 1) {
        expect(midRow).toBe("d");
      } else if (w === 2) {
        // Drops marker away from typing direction (left marker dropped first -> "d…")
        expect(midRow).toBe("d…");
      } else if (w === 3) {
        expect(midRow).toBe("…d…");
      }

      // Move cursor left onto 'c' -> typing direction is left, so at width 2 right marker is dropped first ("…c")
      input.feed({ name: "left", ctrl: false, meta: false, shift: false });
      await app.settle();
      checkRow("c");
      const leftMovedRow = app.frame().split("\n")[0]!.slice(0, w);
      if (w === 1) {
        expect(leftMovedRow).toBe("c");
      } else if (w === 2) {
        expect(leftMovedRow).toBe("…c");
      } else if (w === 3) {
        expect(leftMovedRow).toBe("…c…");
      }

      await app.dispose();
    }
  });

  test("at widths 1, 2 and 3 with a wide character under the cursor it never shows only ellipsis or throws", async () => {
    for (const w of [1, 2, 3]) {
      const input = createLineInput({ initial: "a😀b" });
      input.set("a😀b", 1); // cursor on 😀 (width 2)
      app = await mount({
        ui: () => (
          <box width={w} height={1}>
            <InputLine input={input} width={w} />
          </box>
        ),
      });

      const row = app.frame().split("\n")[0]!.slice(0, w);
      expect(row.trim()).not.toBe("…");
      expect(row.trim()).not.toBe("……");
      if (w >= 2) {
        expect(row).toContain("😀");
      }

      await app.dispose();
    }
  });
});

describe("Round 2 Fix 5: clear() closes every dialog even when one onClose throws", () => {
  test("three dialogs whose top onClose throws: after clear() no dialog and no modal layer is left and the other two promises have settled", async () => {
    app = await mount();
    const firstPromise = app.api.dialog.prompt({ title: "First" });
    const secondPromise = app.api.dialog.confirm({ title: "Second" });
    app.api.dialog.open(() => <text>Third</text>, {
      onClose: () => {
        throw new Error("top onClose boom");
      },
    });
    await app.settle();
    expect(app.api.dialog.depth()).toBe(3);

    expect(() => app.api.dialog.clear()).toThrow("top onClose boom");
    await app.settle();

    expect(app.api.dialog.depth()).toBe(0);
    expect(await firstPromise).toBeNull();
    expect(await secondPromise).toBe(false);

    // No modal layer is left: keys reach the workspace panes again
    expect(app.api.focus.pane()).toBe("editor");
    await app.press("<C-w>h");
    expect(app.api.focus.pane()).toBe("schema");
  });

  test("on unmount, an onClose error is reported through the status line instead of throwing while still closing all dialogs", async () => {
    app = await mount();
    const firstPromise = app.api.dialog.prompt({ title: "First" });
    app.api.dialog.open(() => <text>Second</text>, {
      onClose: () => {
        throw new Error("unmount onClose boom");
      },
    });
    await app.settle();
    expect(app.api.dialog.depth()).toBe(2);

    await app.dispose();

    expect(await firstPromise).toBeNull();
    expect(app.api.status.message()).toEqual({
      text: "unmount onClose boom",
      kind: "error",
    });
  });
});

describe("Follow-up Fix 1: confirm dialog taller than the terminal keeps its title and buttons", () => {
  test("at 70 by 16 with a 30-line message, shows title, line 1, more lines row and both buttons; a three-line message is drawn as before", async () => {
    app = await mount({ width: 70, height: 16, ui: () => <text>base</text> });
    const lines30 = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    void app.api.dialog.confirm({
      title: "Drop database?",
      message: lines30,
      confirm: "Yes",
      cancel: "No",
    });
    await app.settle();

    const frame = app.frame();
    expect(frame).toContain("Drop database?");
    expect(frame).toContain("line 1");
    expect(frame).toMatch(/… \d+ more lines/);
    expect(frame).toContain("No");
    expect(frame).toContain("Yes");

    // Also test a long wrapping single line that wraps into many rows
    app.api.dialog.clear();
    await app.settle();

    const longWrapped = Array.from({ length: 200 }, (_, i) => `word${i + 1}`).join(" ");
    void app.api.dialog.confirm({
      title: "Wrap title",
      message: longWrapped,
      confirm: "Yes",
      cancel: "No",
    });
    await app.settle();
    const wrapFrame = app.frame();
    expect(wrapFrame).toContain("Wrap title");
    expect(wrapFrame).toContain("word1");
    expect(wrapFrame).toMatch(/… \d+ more lines/);
    expect(wrapFrame).toContain("No");
    expect(wrapFrame).toContain("Yes");

    app.api.dialog.clear();
    await app.settle();

    // Three-line message is drawn as before
    void app.api.dialog.confirm({
      title: "Short confirm",
      message: "three 1\nthree 2\nthree 3",
      confirm: "Yes",
      cancel: "No",
    });
    await app.settle();

    const shortFrame = app.frame();
    const shortLines = shortFrame.split("\n");
    const r1 = shortLines.findIndex((l) => l.includes("three 1"));
    const r2 = shortLines.findIndex((l) => l.includes("three 2"));
    const r3 = shortLines.findIndex((l) => l.includes("three 3"));
    expect(r1).toBeGreaterThanOrEqual(0);
    expect(r2).toBe(r1 + 1);
    expect(r3).toBe(r1 + 2);
    expect(shortFrame).not.toContain("more lines");
    expect(shortFrame).toContain("Short confirm");
    expect(shortFrame).toContain("No");
    expect(shortFrame).toContain("Yes");
  });
});

import { DialogSelect } from "./select";

describe("Follow-up Fix 2: a long description never squeezes an option's title out of a select row", () => {
  test("at dialog widths 40, 64 and 80 keeps titles whole, cuts long descriptions with …, keeps or drops hints whole, and stays one line per option when moving and filtering", async () => {
    const desc10 = "0123456789";
    const desc60Wide = "wide-" + "漢字".repeat(13) + "end";
    const desc300 = "path/" + "x".repeat(295);
    const title100 = "LongTitle_" + "T".repeat(90);
    const title31 = "TightRow_" + "X".repeat(22);

    expect(Bun.stringWidth(desc10)).toBe(10);
    expect(Bun.stringWidth(desc60Wide)).toBe(60);
    expect(Bun.stringWidth(desc300)).toBe(300);
    expect(Bun.stringWidth(title100)).toBe(100);
    expect(Bun.stringWidth(title31)).toBe(31);

    const options: SelectOption<string>[] = [
      { title: "Claude Code", value: "claude", description: desc10 },
      { title: "Antigravity", value: "antigravity", description: desc60Wide },
      { title: "OpenCode", value: "opencode", description: desc300, hint: "ctrl+o" },
      { title: title31, value: "tight", description: desc10, hint: "alt+shift+enter" },
      { title: title100, value: "long", description: desc60Wide, hint: "never-fits" },
    ];

    for (const width of [40, 64, 80]) {
      app = await mount({ width: 120, height: 36, ui: () => <text>base</text> });
      app.api.dialog.open(
        (close) => (
          <DialogSelect
            title="Pick agent"
            options={options}
            current="claude"
            onSelect={() => close()}
          />
        ),
        { width },
      );
      await app.settle();

      const assertInvariants = (visibleValues: string[]) => {
        const lines = app.frame().split("\n");
        for (const line of lines) {
          expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
        }

        const rowIndices: number[] = [];
        for (const val of visibleValues) {
          if (val === "claude") {
            const idx = lines.findIndex((l) => l.includes("Claude Code"));
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(lines[idx]).toContain(desc10);
            rowIndices.push(idx);
          } else if (val === "antigravity") {
            const idx = lines.findIndex((l) => l.includes("Antigravity"));
            expect(idx).toBeGreaterThanOrEqual(0);
            const row = lines[idx]!;
            // At width 40 (content 36) and 64 (content 60), 60-cell description is cut with …
            if (width <= 64) {
              expect(row).toContain("…");
            }
            rowIndices.push(idx);
          } else if (val === "opencode") {
            const idx = lines.findIndex((l) => l.includes("OpenCode"));
            expect(idx).toBeGreaterThanOrEqual(0);
            const row = lines[idx]!;
            // 300-cell description is always cut with … and hint ctrl+o fits whole
            expect(row).toContain("path/");
            expect(row).toContain("…");
            expect(row).toContain("ctrl+o");
            rowIndices.push(idx);
          } else if (val === "tight") {
            const idx = lines.findIndex((l) => l.includes(title31));
            expect(idx).toBeGreaterThanOrEqual(0);
            const row = lines[idx]!;
            if (width === 40) {
              // At width 40 (content 36), hint (15) does not fit after 2+31+1, and only 2 cells (<4) remain for description
              expect(row).not.toContain("alt+shift+enter");
              expect(row).not.toContain(desc10);
            } else {
              // At widths 64 and 80, both 10-cell description and 15-cell hint fit whole
              expect(row).toContain(desc10);
              expect(row).toContain("alt+shift+enter");
            }
            rowIndices.push(idx);
          } else if (val === "long") {
            const idx = lines.findIndex((l) => l.includes("LongTitle_TTT"));
            expect(idx).toBeGreaterThanOrEqual(0);
            const row = lines[idx]!;
            expect(row.trimEnd().endsWith("…")).toBe(true);
            expect(row).not.toContain("never-fits");
            rowIndices.push(idx);
          }
        }

        // Each option occupies exactly one line (consecutive row indices)
        for (let i = 1; i < rowIndices.length; i++) {
          expect(rowIndices[i]).toBe(rowIndices[i - 1]! + 1);
        }
      };

      assertInvariants(["claude", "antigravity", "opencode", "tight", "long"]);

      // Moving the selection keeps invariants true
      await app.press("<Down>");
      assertInvariants(["claude", "antigravity", "opencode", "tight", "long"]);
      await app.press("<Down>");
      assertInvariants(["claude", "antigravity", "opencode", "tight", "long"]);

      // Typing a filter keeps invariants true
      await app.press("Anti");
      assertInvariants(["antigravity"]);

      await app.dispose();
    }
  });
});

describe("Fix 1 (Task 22): select notice never pushes content off screen", () => {
  test("unit-level select with notice of 1, 4, 5 and 500 lines at heights 12 to 40", async () => {
    const options: SelectOption<string>[] = [
      { title: "Try again", value: "retry" },
      { title: "Choose another", value: "another" },
      { title: "Use it anyway", value: "anyway" },
      { title: "Fourth option", value: "fourth" },
      { title: "Fifth option", value: "fifth" },
    ];

    for (const lineCount of [1, 4, 5, 500]) {
      const noticeText = Array.from({ length: lineCount }, (_, i) => `notice-line-${i + 1}`).join("\n");
      app = await mount({ width: 60, height: 24, ui: () => <text>base</text> });
      void app.api.dialog.select({
        title: "Notice dialog",
        description: "Pick an action below.",
        notice: { text: noticeText, kind: "error" },
        options,
      });
      await app.settle();

      for (const h of [12, 16, 20, 24, 32, 40]) {
        await app.resize(60, h);
        const frame = app.frame();
        const lines = frame.split("\n");
        expect(frame).toContain("Notice dialog");
        expect(frame).toContain("esc");
        expect(frame).toContain("Try again");
        expect(frame).toContain("Choose another");
        expect(frame).toContain("Use it anyway");

        const noticeLinesInFrame = lines.filter((l) => l.includes("notice-line-"));
        expect(noticeLinesInFrame.length).toBeLessThanOrEqual(4);
        for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
        // The list keeps at least min(options, 3) rows: the first three options are all on screen.
        const titleRow = lines.findIndex((l) => l.includes("Notice dialog"));
        const firstOption = lines.findIndex((l) => l.includes("Try again"));
        expect(titleRow).toBeGreaterThanOrEqual(0);
        expect(firstOption).toBeGreaterThan(titleRow);
        if (lineCount > 1 && h >= 16) expect(noticeLinesInFrame.length).toBeGreaterThanOrEqual(1);
        if (lineCount > 4) expect(noticeLinesInFrame[noticeLinesInFrame.length - 1]?.trimEnd().endsWith("…") ?? true).toBe(true);

        if (h >= 24) {
          expect(frame).toContain("notice-line-1");
          if (lineCount <= 4) {
            expect(noticeLinesInFrame.length).toBe(lineCount);
            expect(frame).not.toContain("…");
          } else {
            expect(noticeLinesInFrame.length).toBe(4);
            expect(noticeLinesInFrame[3]!.trimEnd().endsWith("…")).toBe(true);
            expect(frame).not.toContain("notice-line-5");
          }
        }
      }

      await app.dispose();
    }
  });
});

describe("Task 22 review: select notices are bounded", () => {
  test("a notice of one line of 100,000 characters wraps to at most four rows ending with …", async () => {
    app = await mount({ width: 60, height: 24, ui: () => <text>base</text> });
    void app.api.dialog.select({
      title: "Bounded",
      notice: { text: `START${"y".repeat(100_000)}`, kind: "error" },
      options: [{ title: "Only option", value: 1 }],
    });
    await app.settle();
    const rows = app.frame().split("\n").filter((l) => l.includes("yyyy"));
    expect(rows.length).toBe(4);
    expect(app.frame()).toContain("START");
    expect(rows[3]!.trimEnd().endsWith("…")).toBe(true);
    expect(app.frame()).toContain("Only option");
  });

  test("a short notice that is wider than the dialog wraps whole, without …", async () => {
    app = await mount({ width: 60, height: 24, ui: () => <text>base</text> });
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
    void app.api.dialog.select({ title: "Wrapped", notice: { text, kind: "info" }, options: [{ title: "One", value: 1 }] });
    await app.settle();
    const frame = app.frame();
    for (const word of text.split(" ")) expect(frame).toContain(word);
    expect(frame).not.toContain("…");
  });

  test("the title, options and action hints stay on screen with a long description and notice at 40 by 12", async () => {
    app = await mount({ width: 40, height: 12, ui: () => <text>base</text> });
    void app.api.dialog.select({
      title: "Small",
      description: "A description that is long enough to need several rows at this width of the terminal.",
      notice: { text: Array.from({ length: 50 }, (_, i) => `n${i}`).join("\n"), kind: "error" },
      options: [
        { title: "First", value: 1 },
        { title: "Second", value: 2 },
        { title: "Third", value: 3 },
        { title: "Fourth", value: 4 },
      ],
      actions: [{ key: "<C-e>", label: "edit", run: () => {} }],
    });
    await app.settle();
    const frame = app.frame();
    for (const text of ["Small", "esc", "First", "Second", "Third", "ctrl+e edit"]) expect(frame).toContain(text);
  });
});
