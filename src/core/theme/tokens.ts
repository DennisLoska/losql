export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const THEME_TOKENS = [
  "primary",
  "secondary",
  "accent",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "background",
  "backgroundPanel",
  "backgroundElement",
  "border",
  "borderActive",
  "borderSubtle",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface Theme extends Record<ThemeToken, Rgba> {
  name: string;
  mode: "dark" | "light";
  transparent: boolean;
  paneBackground: Rgba;
  overlayBackground: Rgba;
  selection: Rgba;
}

export type ThemeValue = string | { dark: string; light: string };

export interface ThemeJson {
  $schema?: string;
  defs?: Record<string, string>;
  theme: Record<string, ThemeValue>;
}

export class ThemeError extends Error {}
