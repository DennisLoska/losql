import { type Accessor, createComputed, createSignal, onCleanup, untrack } from "solid-js";
import type { Clock } from "./clock";

export type Easing = (t: number) => number;

export const linear: Easing = (t: number) => t;

export const easeOutCubic: Easing = (t: number) => 1 - Math.pow(1 - t, 3);

export const easeInOutCubic: Easing = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export function tweenValue(
  from: number,
  to: number,
  elapsedMs: number,
  durationMs: number,
  ease: Easing = easeOutCubic,
): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return to;
  if (elapsedMs <= 0) return from;
  return from + (to - from) * ease(elapsedMs / durationMs);
}

export function createTween(
  target: Accessor<number>,
  options: { duration: number; ease?: Easing; clock: Clock; enabled: Accessor<boolean> },
): Accessor<number> {
  const initial = untrack(target);
  const [value, setValue] = createSignal(initial);
  let current = initial;
  let unsubscribe: (() => void) | null = null;

  const stop = () => {
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  createComputed(() => {
    const next = target();
    const isEnabled = options.enabled();

    if (!isEnabled || options.duration <= 0) {
      stop();
      current = next;
      setValue(next);
      return;
    }

    if (next === current) {
      stop();
      return;
    }

    stop();
    const from = current;
    const start = options.clock.now();
    const duration = options.duration;
    const ease = options.ease ?? easeOutCubic;

    unsubscribe = options.clock.onFrame((now) => {
      const elapsed = now - start;
      const nextVal = tweenValue(from, next, elapsed, duration, ease);
      current = nextVal;
      setValue(nextVal);
      if (elapsed >= duration) {
        stop();
      }
    });
  });

  onCleanup(stop);

  return () => (options.enabled() ? value() : target());
}
