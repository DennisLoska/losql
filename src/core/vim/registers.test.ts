import { describe, expect, test } from "bun:test";
import { Registers } from "./registers";

describe("Registers", () => {
  test("unnamed and 0 register on yank and delete", () => {
    const r = new Registers();
    expect(r.read('"')).toBeNull();
    expect(r.read(null)).toBeNull();

    r.write(null, { text: "foo", linewise: false }, true);
    expect(r.read('"')).toEqual({ text: "foo", linewise: false });
    expect(r.read("0")).toEqual({ text: "foo", linewise: false });
    expect(r.read("+")).toEqual({ text: "foo", linewise: false });
    expect(r.read("*")).toEqual({ text: "foo", linewise: false });

    r.write(null, { text: "bar", linewise: false }, false);
    expect(r.read('"')).toEqual({ text: "bar", linewise: false });
    expect(r.read("0")).toEqual({ text: "foo", linewise: false });
  });

  test("named registers and black hole register", () => {
    const r = new Registers();
    r.write("a", { text: "alpha\n", linewise: true }, true);
    expect(r.read("a")).toEqual({ text: "alpha\n", linewise: true });
    expect(r.read('"')).toEqual({ text: "alpha\n", linewise: true });
    expect(r.read("0")).toEqual({ text: "alpha\n", linewise: true });

    // Black hole register '_' discards writes and reads as null
    r.write("_", { text: "ignored", linewise: false }, false);
    expect(r.read("_")).toBeNull();
    expect(r.read('"')).toEqual({ text: "alpha\n", linewise: true });
  });
});
