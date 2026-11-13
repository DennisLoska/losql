import { describe, expect, test } from "bun:test";
import { formatDuration } from "./duration";

describe("formatDuration", () => {
  test("negative and non-finite values give 0 ms", () => {
    expect(formatDuration(-1)).toBe("0 ms");
    expect(formatDuration(-0.001)).toBe("0 ms");
    expect(formatDuration(Number.NaN)).toBe("0 ms");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0 ms");
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe("0 ms");
  });

  test("below 10 ms shows one decimal", () => {
    expect(formatDuration(0)).toBe("0.0 ms");
    expect(formatDuration(0.3593740000000025)).toBe("0.4 ms");
    expect(formatDuration(9.94)).toBe("9.9 ms");
  });

  test("from 10 ms to below 1,000 ms shows an integer", () => {
    expect(formatDuration(9.96)).toBe("10 ms");
    expect(formatDuration(10)).toBe("10 ms");
    expect(formatDuration(12.3)).toBe("12 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(999.4)).toBe("999 ms");
  });

  test("from 1 second to below 60 seconds shows two decimals in seconds", () => {
    expect(formatDuration(999.6)).toBe("1.00 s");
    expect(formatDuration(1000)).toBe("1.00 s");
    expect(formatDuration(1250)).toBe("1.25 s");
    expect(formatDuration(59_990)).toBe("59.99 s");
  });

  test("from 60 seconds shows minutes and two-digit seconds", () => {
    expect(formatDuration(59_999)).toBe("1 m 00 s");
    expect(formatDuration(60_000)).toBe("1 m 00 s");
    expect(formatDuration(125_000)).toBe("2 m 05 s");
    expect(formatDuration(125_400)).toBe("2 m 05 s");
  });
});
