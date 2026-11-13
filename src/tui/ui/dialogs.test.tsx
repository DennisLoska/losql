import { afterEach, describe, expect, test } from "bun:test";
import { SPINNER_FRAMES, SPINNER_STATIC } from "../motion/shimmer";
import { mount, spanWith, type TestApp } from "../testing";
import { LOGO, Logo } from "./logo";
import { Shimmer } from "./shimmer";
import { Spinner } from "./spinner";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

const fruit = [
  { title: "Apple", value: "apple" },
  { title: "Apricot", value: "apricot", description: "stone fruit" },
  { title: "Banana", value: "banana", hint: "yellow" },
  { title: "Cherry", value: "cherry" },
];

describe("select", () => {
  test("shows options, filters as you type and confirms with Enter", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const picked = app.api.dialog.select({ title: "Pick one", options: fruit });
    await app.settle();
    expect(app.api.dialog.depth()).toBe(1);
    for (const text of ["Pick one", "Apple", "Apricot", "stone fruit", "Banana", "yellow", "Cherry"]) {
      expect(app.frame()).toContain(text);
    }
    await app.press("ap");
    expect(app.frame()).toContain("Apricot");
    expect(app.frame()).not.toContain("Banana");
    await app.press("<C-n><CR>");
    expect(await picked).toBe("apricot");
    expect(app.api.dialog.depth()).toBe(0);
    expect(app.frame()).not.toContain("Pick one");
  });

  test("arrows and ctrl+p move, and the selection wraps", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const moves: (string | null)[] = [];
    const picked = app.api.dialog.select({ title: "Pick", options: fruit, onMove: (o) => moves.push(o?.value ?? null) });
    await app.settle();
    await app.press("<Down><Down><Up><C-p><C-p>");
    expect(moves).toEqual(["apricot", "banana", "apricot", "apple", "cherry"]);
    await app.press("<CR>");
    expect(await picked).toBe("cherry");
  });

  test("Escape and ctrl+c dismiss with null", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const first = app.api.dialog.select({ title: "Pick", options: fruit });
    await app.settle();
    await app.press("<Esc>");
    expect(await first).toBeNull();
    const second = app.api.dialog.select({ title: "Pick", options: fruit });
    await app.settle();
    await app.press("<C-c>");
    expect(await second).toBeNull();
    expect(app.deps.exits).toEqual([]);
  });

  test("the current value is marked and selected first", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const picked = app.api.dialog.select({ title: "Pick", options: fruit, current: "banana" });
    await app.settle();
    expect(app.frame()).toContain("●");
    await app.press("<CR>");
    expect(await picked).toBe("banana");
  });

  test("disabled options are skipped", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const options = [fruit[0]!, { ...fruit[1]!, disabled: true }, fruit[2]!];
    const picked = app.api.dialog.select({ title: "Pick", options });
    await app.settle();
    await app.press("<C-n><CR>");
    expect(await picked).toBe("banana");
  });

  test("categories are shown as headings until a filter is typed", async () => {
    app = await mount({ ui: () => <text>base</text> });
    void app.api.dialog.select({
      title: "Pick",
      options: [
        { title: "Apple", value: 1, category: "Fruit" },
        { title: "Carrot", value: 2, category: "Vegetables" },
      ],
    });
    await app.settle();
    expect(app.frame()).toContain("Fruit");
    expect(app.frame()).toContain("Vegetables");
    await app.press("car");
    expect(app.frame()).not.toContain("Fruit");
    expect(app.frame()).toContain("Carrot");
  });

  test("nothing matching shows the empty text and Enter does nothing", async () => {
    app = await mount({ ui: () => <text>base</text> });
    void app.api.dialog.select({ title: "Pick", options: fruit, empty: "Nothing here" });
    await app.settle();
    await app.press("zzz<CR>");
    expect(app.frame()).toContain("Nothing here");
    expect(app.api.dialog.depth()).toBe(1);
  });

  test("action keys run on the selected option and are listed", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const deleted: string[] = [];
    void app.api.dialog.select({
      title: "Pick",
      options: fruit,
      actions: [{ key: "<C-d>", label: "delete", run: (o) => deleted.push(o.value) }],
    });
    await app.settle();
    expect(app.frame()).toContain("ctrl+d delete");
    await app.press("<C-n><C-d>");
    expect(deleted).toEqual(["apricot"]);
    expect(app.api.dialog.depth()).toBe(1);
  });

  test("a description and a notice are shown", async () => {
    app = await mount({ ui: () => <text>base</text> });
    void app.api.dialog.select({ title: "Pick", description: "Choose wisely", notice: { text: "that did not work", kind: "error" }, options: fruit });
    await app.settle();
    expect(app.frame()).toContain("Choose wisely");
    expect(spanWith(app.spans(), "that did not work")!.fg.toInts()).toEqual(app.api.theme.color("error").toInts());
  });

  test("a custom entry is offered for text that equals no title", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const options = [{ title: "default", value: "default" }, { title: "sonnet", value: "sonnet" }];
    const custom = (text: string) => ({ title: `Use "${text}"`, value: text });
    const first = app.api.dialog.select({ title: "Model", options, custom });
    await app.settle();
    expect(app.frame()).not.toContain("Use ");
    await app.press("sonnet");
    expect(app.frame()).not.toContain('Use "sonnet"');
    await app.press("-next");
    expect(app.frame()).toContain('Use "sonnet-next"');
    await app.press("<CR>");
    expect(await first).toBe("sonnet-next");
  });

  test("a long list scrolls with the selection", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const many = Array.from({ length: 60 }, (_, i) => ({ title: `option-${String(i).padStart(2, "0")}`, value: i }));
    const picked = app.api.dialog.select({ title: "Pick", options: many });
    await app.settle();
    expect(app.frame()).toContain("option-00");
    expect(app.frame()).not.toContain("option-45");
    await app.press("<C-n>".repeat(45));
    expect(app.frame()).toContain("option-45");
    expect(app.frame()).not.toContain("option-00");
    await app.press("<CR>");
    expect(await picked).toBe(45);
  });
});

describe("prompt", () => {
  test("returns the typed text", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const answer = app.api.dialog.prompt({ title: "Name", description: "What is it called?", placeholder: "a name" });
    await app.settle();
    expect(app.frame()).toContain("What is it called?");
    expect(app.frame()).toContain("a name");
    await app.press("devx<BS><CR>");
    expect(await answer).toBe("dev");
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("starts with the initial text and returns null on Escape", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const answer = app.api.dialog.prompt({ title: "Name", initial: "old" });
    await app.settle();
    expect(app.frame()).toContain("old");
    await app.press("<Esc>");
    expect(await answer).toBeNull();
  });

  test("a validation error keeps the dialog open", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const answer = app.api.dialog.prompt({
      title: "URL",
      validate: async (value) => (value.startsWith("postgres://") ? null : "not a postgres URL"),
    });
    await app.settle();
    await app.press("nope<CR>");
    await app.waitFor(() => app.frame().includes("not a postgres URL"));
    expect(app.api.dialog.depth()).toBe(1);
    await app.press("<C-u>postgres://x<CR>");
    expect(await answer).toBe("postgres://x");
  });

  test("masked input hides the text and paste works", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const answer = app.api.dialog.prompt({ title: "Password", mask: true });
    await app.settle();
    app.api.keys.paste("hunter2");
    await app.settle();
    expect(app.frame()).not.toContain("hunter2");
    expect(app.frame()).toContain("•••••••");
    await app.press("<CR>");
    expect(await answer).toBe("hunter2");
  });
});

describe("confirm", () => {
  const ask = () =>
    app.api.dialog.confirm({ title: "Run this?", message: "It changes data.", confirm: "Run", danger: true });

  test("Cancel is selected first", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const answer = ask();
    await app.settle();
    for (const text of ["Run this?", "It changes data.", "Run", "Cancel"]) expect(app.frame()).toContain(text);
    await app.press("<CR>");
    expect(await answer).toBe(false);
  });

  test.each([
    ["y", true],
    ["<Tab><CR>", true],
    ["l<CR>", true],
    ["lh<CR>", false],
    ["n", false],
    ["<Esc>", false],
  ] as const)("%s answers %p", async (keys, expected) => {
    app = await mount({ ui: () => <text>base</text> });
    const answer = ask();
    await app.settle();
    await app.press(keys);
    expect(await answer).toBe(expected);
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("a body is rendered", async () => {
    app = await mount({ ui: () => <text>base</text> });
    void app.api.dialog.confirm({ title: "Sure?", body: () => <text>delete from orders</text> });
    await app.settle();
    expect(app.frame()).toContain("delete from orders");
  });

  test("Y answers true and N answers false", async () => {
    app = await mount({ ui: () => <text>base</text> });
    const yes = ask();
    await app.settle();
    await app.press("Y");
    expect(await yes).toBe(true);
    const no = ask();
    await app.settle();
    await app.press("N");
    expect(await no).toBe(false);
  });

  test("a body of 500 rows at heights 8 to 40 keeps the title and buttons visible", async () => {
    app = await mount({ width: 80, height: 8, ui: () => <text>base</text> });
    void app.api.dialog.confirm({
      title: "Run this statement?",
      message: "The agent proposed a statement that is not a read.",
      body: () => (
        <box flexDirection="column" width="100%">
          {Array.from({ length: 500 }, (_, i) => (
            <text>{`row-${i}`}</text>
          ))}
        </box>
      ),
      confirm: "Run",
      danger: true,
    });
    await app.settle();
    for (const h of [8, 12, 16, 24, 32, 40]) {
      await app.resize(80, h);
      const f = app.frame();
      expect(f).toContain("Run this statement?");
      expect(f).toContain("Cancel");
      expect(f).toContain("Run");
    }
  });
});


describe("the dialog stack", () => {
  test("dialogs stack, Escape closes the top one, and keys do not reach the Panes", async () => {
    app = await mount();
    const closed: string[] = [];
    app.api.dialog.open(() => <text>first dialog</text>, { onClose: () => closed.push("first") });
    app.api.dialog.open(() => <text>second dialog</text>, { onClose: () => closed.push("second") });
    await app.settle();
    expect(app.api.dialog.depth()).toBe(2);
    expect(app.frame()).toContain("second dialog");
    await app.press("<C-w>h");
    expect(app.api.focus.pane()).toBe("editor");
    await app.press("<Esc>");
    expect(closed).toEqual(["second"]);
    expect(app.frame()).toContain("first dialog");
    app.api.dialog.clear();
    await app.settle();
    expect(closed).toEqual(["second", "first"]);
    expect(app.api.dialog.depth()).toBe(0);
    await app.press("<C-w>h");
    expect(app.api.focus.pane()).toBe("schema");
  });

  test("the close function passed to render closes that dialog", async () => {
    app = await mount({ ui: () => <text>base</text> });
    let close = () => {};
    app.api.dialog.open((c) => {
      close = c;
      return <text>closable</text>;
    });
    await app.settle();
    close();
    await app.settle();
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("a dialog stays opaque when the theme is Transparent", async () => {
    app = await mount({ config: { transparent: true } });
    void app.api.dialog.select({ title: "Pick one", options: fruit });
    await app.settle();
    expect(spanWith(app.spans(), "Pick one")!.bg.toInts()[3]).toBe(255);
    expect(spanWith(app.spans(), "Banana")!.bg.toInts()[3]).toBe(255);
  });
});

describe("toasts", () => {
  test("a toast appears and leaves after its duration", async () => {
    app = await mount();
    app.api.toast.show({ message: "Saved the thing", kind: "success" });
    await app.settle();
    expect(app.frame()).toContain("Saved the thing");
    expect(app.api.toast.items().length).toBe(1);
    await app.advance(3900);
    expect(app.frame()).toContain("Saved the thing");
    await app.advance(200);
    expect(app.api.toast.items()).toEqual([]);
    expect(app.frame()).not.toContain("Saved the thing");
  });

  test("toasts stack, carry a title, and are opaque", async () => {
    app = await mount({ config: { transparent: true } });
    app.api.toast.show({ message: "first message", title: "Heads up", kind: "warning", duration: 1000 });
    app.api.toast.show({ message: "second message", kind: "error", duration: 5000 });
    await app.settle();
    for (const text of ["first message", "Heads up", "second message"]) expect(app.frame()).toContain(text);
    expect(spanWith(app.spans(), "second message")!.bg.toInts()[3]).toBe(255);
    await app.advance(1100);
    expect(app.frame()).not.toContain("first message");
    expect(app.frame()).toContain("second message");
  });

  test("config warnings from startup are shown as toasts", async () => {
    app = await mount({ config: { leader: "" } });
    await app.settle();
    expect(app.api.toast.items().some((t) => t.kind === "warning" && t.message.includes('"leader"'))).toBe(true);
  });
});

describe("spinner, shimmer and logo", () => {
  test("the spinner is static when animations are off", async () => {
    app = await mount({ ui: () => <Spinner label="working" /> });
    expect(app.frame()).toContain(`${SPINNER_STATIC} working`);
  });

  test("the spinner turns when animations are on", async () => {
    app = await mount({ animations: true, ui: () => <Spinner label="working" /> });
    expect(app.frame()).toContain(SPINNER_FRAMES[0]!);
    await app.advance(80);
    expect(app.frame()).toContain(SPINNER_FRAMES[1]!);
  });

  test("shimmer text is readable in both modes", async () => {
    app = await mount({ ui: () => <Shimmer text="thinking about it" /> });
    expect(app.frame()).toContain("thinking about it");
    await app.dispose();
    app = await mount({ animations: true, ui: () => <Shimmer text="thinking about it" /> });
    await app.advance(300);
    expect(app.frame()).toContain("thinking about it");
  });

  test("the logo is drawn", async () => {
    app = await mount({ ui: () => <Logo /> });
    expect(LOGO.length).toBeGreaterThanOrEqual(3);
    expect(LOGO.length).toBeLessThanOrEqual(5);
    for (const line of LOGO) {
      expect(line.length).toBeLessThanOrEqual(40);
      expect(app.frame()).toContain(line.trimEnd());
    }
  });
});
