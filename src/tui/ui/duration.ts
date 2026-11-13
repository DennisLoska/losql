export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0 ms";
  }

  const tenthsMs = Math.round(ms * 10) / 10;
  if (tenthsMs < 10) {
    return `${tenthsMs.toFixed(1)} ms`;
  }

  const intMs = Math.round(ms);
  if (intMs < 1000) {
    return `${intMs} ms`;
  }

  const hundredthsSec = Math.round((ms / 1000) * 100) / 100;
  if (hundredthsSec < 60) {
    return `${hundredthsSec.toFixed(2)} s`;
  }

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} m ${String(seconds).padStart(2, "0")} s`;
}
