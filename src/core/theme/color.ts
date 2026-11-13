import { type Rgba, ThemeError } from "./tokens";

export function parseColor(value: string): Rgba {
  if (value === "transparent" || value === "none") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const r = Number.parseInt(value[1]! + value[1]!, 16);
    const g = Number.parseInt(value[2]! + value[2]!, 16);
    const b = Number.parseInt(value[3]! + value[3]!, 16);
    return { r, g, b, a: 255 };
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    const r = Number.parseInt(value.slice(1, 3), 16);
    const g = Number.parseInt(value.slice(3, 5), 16);
    const b = Number.parseInt(value.slice(5, 7), 16);
    return { r, g, b, a: 255 };
  }
  if (/^#[0-9a-fA-F]{8}$/.test(value)) {
    const r = Number.parseInt(value.slice(1, 3), 16);
    const g = Number.parseInt(value.slice(3, 5), 16);
    const b = Number.parseInt(value.slice(5, 7), 16);
    const a = Number.parseInt(value.slice(7, 9), 16);
    return { r, g, b, a };
  }
  throw new ThemeError(`not a color: ${value}`);
}

function byteHex(n: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(n)));
  return clamped.toString(16).padStart(2, "0");
}

export function toHex(color: Rgba): string {
  const rgb = `#${byteHex(color.r)}${byteHex(color.g)}${byteHex(color.b)}`;
  return color.a < 255 ? `${rgb}${byteHex(color.a)}` : rgb;
}

export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
    a: Math.round(a.a + (b.a - a.a) * t),
  };
}
