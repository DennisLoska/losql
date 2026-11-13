import { describe, expect, test } from "bun:test";
import { escapeControl } from "./terminal-text";

describe("escapeControl", () => {
  test("keeps printable ASCII, Unicode, line feeds, and tabs unchanged", () => {
    const input = "SELECT *\tFROM users\nWHERE name = 'Ångström 😀';\n";
    expect(escapeControl(input)).toBe(input);
  });

  test("normalizes CRLF to LF and escapes standalone CR", () => {
    expect(escapeControl("line1\r\nline2\r\n")).toBe("line1\nline2\n");
    expect(escapeControl("overwrite\rsecret")).toBe("overwrite\\x0dsecret");
    expect(escapeControl("a\r\r\nb")).toBe("a\\x0d\nb");
  });

  test("escapes C0 control characters (except LF and TAB), DEL, and C1 control characters", () => {
    expect(escapeControl("\u0000\u0007\u0008\u000b\u000c\u001b\u001f")).toBe(
      "\\x00\\x07\\x08\\x0b\\x0c\\x1b\\x1f",
    );
    expect(escapeControl("\u007f")).toBe("\\x7f");
    expect(escapeControl("\u0080\u0090\u009b\u009f")).toBe("\\x80\\x90\\x9b\\x9f");
    expect(escapeControl("\u00a0")).toBe("\u00a0");
  });

  test("escapes OSC title sequences and CSI color sequences", () => {
    expect(escapeControl("\u001b]0;pwned\u0007 and \u001b[31mred\u001b[0m")).toBe(
      "\\x1b]0;pwned\\x07 and \\x1b[31mred\\x1b[0m",
    );
  });

  test("replaces lone surrogates with U+FFFD while preserving valid surrogate pairs", () => {
    expect(escapeControl("valid: \uD83D\uDE80")).toBe("valid: 🚀");
    expect(escapeControl("lone high: \uD800!")).toBe("lone high: \uFFFD!");
    expect(escapeControl("lone low: \uDC00!")).toBe("lone low: \uFFFD!");
    expect(escapeControl("\uD800\uD83D\uDE80\uDC00")).toBe("\uFFFD🚀\uFFFD");
  });
});
