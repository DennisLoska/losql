import { mix } from "../../core/theme/color";
import type { Rgba } from "../../core/theme/tokens";
import { tweenValue } from "./tween";

export const SPINNER_FRAMES: readonly string[] = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

export const SPINNER_INTERVAL_MS = 80;
export const SPINNER_STATIC = "⋯";

export function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index]!;
}

const SHIMMER_PERIOD_MS = 1200;
const SHIMMER_HALF_WIDTH = 2.5;

export function shimmer(length: number, elapsedMs: number, base: Rgba, highlight: Rgba): Rgba[] {
  if (length <= 0) return [];
  const phase = (((elapsedMs % SHIMMER_PERIOD_MS) + SHIMMER_PERIOD_MS) % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
  const center = phase * length;
  const colors: Rgba[] = [];
  for (let i = 0; i < length; i++) {
    const distance = Math.abs(i - center);
    if (distance >= SHIMMER_HALF_WIDTH) {
      colors.push(base);
    } else {
      const weight = 1 - distance / SHIMMER_HALF_WIDTH;
      colors.push(mix(base, highlight, weight));
    }
  }
  return colors;
}

export function countUp(target: number, elapsedMs: number, durationMs: number): number {
  return Math.round(tweenValue(0, target, elapsedMs, durationMs));
}
