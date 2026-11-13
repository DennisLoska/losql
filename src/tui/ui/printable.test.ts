import { describe, expect, test } from "bun:test";
import { printable } from "./printable";

describe("printable", () => {
  test("leaves ordinary ASCII and Unicode text unchanged", () => {
    expect(printable("Hello, world! naïve 👨‍👩‍👧")).toBe("Hello, world! naïve 👨‍👩‍👧");
  });

  test("replaces tabs and line breaks with spaces by default", () => {
    expect(printable("a\tb\nc\r\nd\re")).toBe("a b c d e");
  });

  test("keeps newlines or tabs when requested", () => {
    expect(printable("a\tb\r\nc", { keepNewlines: true })).toBe("a b\nc");
    expect(printable("a\tb\nc", { keepTabs: true })).toBe("a\tb c");
  });

  test("replaces C0, DEL and C1 control characters with U+FFFD replacement character", () => {
    expect(printable("\x00\x07\x1b[31mred\x7f\x80\x9f")).toBe(
      "\ufffd\ufffd\ufffd[31mred\ufffd\ufffd\ufffd",
    );
    expect(printable("\x1b]0;hi\x07red")).toBe("\ufffd]0;hi\ufffdred");
  });

  test("treats U+2028 and U+2029 as line breaks", () => {
    expect(printable("a\u2028b\u2029c")).toBe("a b c");
    expect(printable("a\u2028b\u2029c", { keepNewlines: true })).toBe("a\nb\nc");
  });
});

