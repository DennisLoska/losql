import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { BUILTIN_THEMES } from "../../core/theme/registry";
import { resolveTheme } from "../../core/theme/resolve";
import { manualClock } from "./clock";
import { mixTheme } from "./color";
import { countUp, shimmer, SPINNER_FRAMES, spinnerFrame } from "./shimmer";
import { createTween, easeInOutCubic, easeOutCubic, linear, tweenValue } from "./tween";

describe("manualClock", () => {
  test("time moves only when advanced", () => {
    const clock = manualClock(100);
    expect(clock.now()).toBe(100);
    clock.advance(50);
    expect(clock.now()).toBe(150);
  });

  test("frame callbacks run on every step of at most 16 ms", () => {
    const clock = manualClock();
    const seen: number[] = [];
    const off = clock.onFrame((now) => seen.push(now));
    clock.advance(40);
    expect(seen).toEqual([16, 32, 40]);
    off();
    clock.advance(40);
    expect(seen.length).toBe(3);
  });

  test("timers fire once, in order, and can be cancelled", () => {
    const clock = manualClock();
    const seen: string[] = [];
    clock.after(30, () => seen.push("b"));
    clock.after(10, () => seen.push("a"));
    const cancel = clock.after(20, () => seen.push("never"));
    cancel();
    clock.advance(9);
    expect(seen).toEqual([]);
    clock.advance(100);
    expect(seen).toEqual(["a", "b"]);
    clock.advance(100);
    expect(seen).toEqual(["a", "b"]);
  });

  test("a timer set from a timer callback is honoured", () => {
    const clock = manualClock();
    const seen: number[] = [];
    clock.after(10, () => clock.after(10, () => seen.push(clock.now())));
    clock.advance(100);
    expect(seen.length).toBe(1);
  });
});

describe("tween", () => {
  test("easings map 0 to 0 and 1 to 1", () => {
    for (const ease of [linear, easeOutCubic, easeInOutCubic]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
    }
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  test("tweenValue clamps", () => {
    expect(tweenValue(0, 10, -5, 100, linear)).toBe(0);
    expect(tweenValue(0, 10, 50, 100, linear)).toBe(5);
    expect(tweenValue(0, 10, 500, 100, linear)).toBe(10);
    expect(tweenValue(3, 3, 50, 0, linear)).toBe(3);
  });

  test("createTween follows its target over time", () => {
    createRoot((dispose) => {
      const clock = manualClock();
      const [target, setTarget] = createSignal(0);
      const value = createTween(target, { duration: 100, ease: linear, clock, enabled: () => true });
      expect(value()).toBe(0);
      setTarget(10);
      clock.advance(48);
      expect(value()).toBeGreaterThan(0);
      expect(value()).toBeLessThan(10);
      clock.advance(100);
      expect(value()).toBe(10);
      dispose();
    });
  });

  test("createTween jumps when disabled", () => {
    createRoot((dispose) => {
      const clock = manualClock();
      const [target, setTarget] = createSignal(0);
      const value = createTween(target, { duration: 100, clock, enabled: () => false });
      setTarget(10);
      expect(value()).toBe(10);
      dispose();
    });
  });
});

describe("spinner, shimmer and count-up", () => {
  test("the spinner cycles through its frames", () => {
    expect(SPINNER_FRAMES.length).toBe(10);
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]!);
    expect(spinnerFrame(80)).toBe(SPINNER_FRAMES[1]!);
    expect(spinnerFrame(800)).toBe(SPINNER_FRAMES[0]!);
  });

  test("shimmer returns one colour per character and moves with time", () => {
    const base = { r: 100, g: 100, b: 100, a: 255 };
    const highlight = { r: 255, g: 255, b: 255, a: 255 };
    const a = shimmer(12, 0, base, highlight);
    const b = shimmer(12, 400, base, highlight);
    expect(a.length).toBe(12);
    expect(a).not.toEqual(b);
    expect(a.some((c) => c.r > 100)).toBe(true);
    expect(shimmer(0, 0, base, highlight)).toEqual([]);
  });

  test("countUp ends on the target", () => {
    expect(countUp(1000, 0, 200)).toBe(0);
    expect(countUp(1000, 100, 200)).toBeGreaterThan(0);
    expect(countUp(1000, 100, 200)).toBeLessThan(1000);
    expect(countUp(1000, 200, 200)).toBe(1000);
    expect(countUp(1000, 900, 200)).toBe(1000);
    expect(countUp(7, 10, 0)).toBe(7);
  });
});

test("mixTheme blends every colour and takes names from the target", () => {
  const a = resolveTheme("tokyonight", BUILTIN_THEMES.tokyonight!, { mode: "dark", transparent: false });
  const b = resolveTheme("nord", BUILTIN_THEMES.nord!, { mode: "dark", transparent: true });
  expect(mixTheme(a, b, 0).background).toEqual(a.background);
  expect(mixTheme(a, b, 1)).toEqual(b);
  const half = mixTheme(a, b, 0.5);
  expect(half.name).toBe("nord");
  expect(half.transparent).toBe(true);
  expect(half.primary).not.toEqual(a.primary);
  expect(half.primary).not.toEqual(b.primary);
  expect(half.paneBackground.a).toBeGreaterThan(0);
  expect(half.paneBackground.a).toBeLessThan(255);
});
