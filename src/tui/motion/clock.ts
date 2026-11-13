export interface Clock {
  now(): number;
  onFrame(callback: (now: number) => void): () => void;
  after(ms: number, callback: () => void): () => void;
}

export interface ManualClock extends Clock {
  advance(ms: number): void;
}

export function realClock(): Clock {
  const subscribers = new Set<(now: number) => void>();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const ensureInterval = () => {
    if (subscribers.size > 0 && intervalId === null) {
      intervalId = setInterval(() => {
        const current = performance.now();
        for (const sub of Array.from(subscribers)) {
          if (subscribers.has(sub)) {
            sub(current);
          }
        }
      }, 16);
    } else if (subscribers.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  return {
    now(): number {
      return performance.now();
    },
    onFrame(callback: (now: number) => void): () => void {
      subscribers.add(callback);
      ensureInterval();
      return () => {
        subscribers.delete(callback);
        ensureInterval();
      };
    },
    after(ms: number, callback: () => void): () => void {
      const id = setTimeout(callback, Math.max(0, ms));
      return () => {
        clearTimeout(id);
      };
    },
  };
}

interface TimerEntry {
  id: number;
  due: number;
  callback: () => void;
}

export function manualClock(start = 0): ManualClock {
  let current = start;
  let nextTimerId = 1;
  const timers = new Map<number, TimerEntry>();
  const subscribers = new Set<(now: number) => void>();

  return {
    now(): number {
      return current;
    },
    onFrame(callback: (now: number) => void): () => void {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    after(ms: number, callback: () => void): () => void {
      const id = nextTimerId++;
      timers.set(id, {
        id,
        due: current + Math.max(0, ms),
        callback,
      });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms: number): void {
      let remaining = ms;
      while (remaining > 0) {
        const step = Math.min(16, remaining);
        current += step;
        remaining -= step;

        while (true) {
          let earliest: TimerEntry | null = null;
          for (const entry of timers.values()) {
            if (entry.due <= current) {
              if (
                earliest === null ||
                entry.due < earliest.due ||
                (entry.due === earliest.due && entry.id < earliest.id)
              ) {
                earliest = entry;
              }
            }
          }
          if (!earliest) break;
          timers.delete(earliest.id);
          earliest.callback();
        }

        for (const sub of Array.from(subscribers)) {
          if (subscribers.has(sub)) {
            sub(current);
          }
        }
      }
    },
  };
}
