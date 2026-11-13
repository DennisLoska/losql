import { mix, parseColor } from "./color";
import { type Rgba, type Theme, ThemeError, type ThemeJson, type ThemeValue } from "./tokens";

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };
const ERROR_DEFAULT = parseColor("#e06c75");
const WARNING_DEFAULT = parseColor("#e5c07b");
const SUCCESS_DEFAULT = parseColor("#98c379");

const MAX_REFERENCE_HOPS = 64;

function isColorLiteral(value: string): boolean {
  return value.startsWith("#") || value === "transparent" || value === "none";
}

export function resolveTheme(
  name: string,
  json: ThemeJson,
  options: { mode: "dark" | "light"; transparent: boolean },
): Theme {
  const { mode, transparent } = options;
  const defs = json.defs ?? {};
  const rawTheme = json.theme ?? {};

  const resolveValue = (token: string, raw: ThemeValue, seen: Set<string>): Rgba => {
    let str: unknown;
    if (typeof raw === "string") {
      str = raw;
    } else if (typeof raw === "object" && raw !== null && typeof raw[mode] === "string") {
      str = raw[mode];
    } else {
      throw new ThemeError(`theme ${name}: unsupported color value for ${token}`);
    }

    if (typeof str !== "string") {
      throw new ThemeError(`theme ${name}: unsupported color value for ${token}`);
    }

    if (isColorLiteral(str)) {
      try {
        return parseColor(str);
      } catch (err) {
        if (err instanceof ThemeError) {
          throw new ThemeError(`theme ${name}: ${err.message}`);
        }
        throw err;
      }
    }

    if (Object.hasOwn(defs, str)) {
      const key = `def:${str}`;
      if (seen.has(key)) {
        throw new ThemeError(`theme ${name}: circular color reference ${str}`);
      }
      if (seen.size > MAX_REFERENCE_HOPS) {
        throw new ThemeError(`theme ${name}: color reference chain too deep for ${token}`);
      }
      seen.add(key);
      try {
        return resolveValue(token, defs[str]!, seen);
      } finally {
        seen.delete(key);
      }
    }
    if (Object.hasOwn(rawTheme, str)) {
      const key = `theme:${str}`;
      if (seen.has(key)) {
        throw new ThemeError(`theme ${name}: circular color reference ${str}`);
      }
      if (seen.size > MAX_REFERENCE_HOPS) {
        throw new ThemeError(`theme ${name}: color reference chain too deep for ${token}`);
      }
      seen.add(key);
      try {
        return resolveValue(token, rawTheme[str]!, seen);
      } finally {
        seen.delete(key);
      }
    }

    throw new ThemeError(`theme ${name}: unknown color reference ${str}`);
  };

  const resolveOptional = (token: string): Rgba | undefined => {
    if (!Object.prototype.hasOwnProperty.call(rawTheme, token) || rawTheme[token] === undefined) {
      return undefined;
    }
    return resolveValue(token, rawTheme[token]!, new Set([`theme:${token}`]));
  };

  const resolveRequired = (token: string): Rgba => {
    const val = resolveOptional(token);
    if (!val) {
      throw new ThemeError(`theme ${name}: missing required color ${token}`);
    }
    return val;
  };

  const primary = resolveRequired("primary");
  const text = resolveRequired("text");
  const rawBackground = resolveRequired("background");

  const opaqueBackground: Rgba =
    rawBackground.a === 255
      ? rawBackground
      : mode === "dark"
        ? { r: 0, g: 0, b: 0, a: 255 }
        : { r: 255, g: 255, b: 255, a: 255 };

  const secondary = resolveOptional("secondary") ?? primary;
  const accent = resolveOptional("accent") ?? primary;
  const error = resolveOptional("error") ?? ERROR_DEFAULT;
  const warning = resolveOptional("warning") ?? WARNING_DEFAULT;
  const success = resolveOptional("success") ?? SUCCESS_DEFAULT;
  const info = resolveOptional("info") ?? primary;
  const textMuted = resolveOptional("textMuted") ?? mix(text, opaqueBackground, 0.4);
  const backgroundPanel = resolveOptional("backgroundPanel") ?? rawBackground;
  const backgroundElement = resolveOptional("backgroundElement") ?? backgroundPanel;
  const border = resolveOptional("border") ?? textMuted;
  const borderActive = resolveOptional("borderActive") ?? primary;
  const borderSubtle = resolveOptional("borderSubtle") ?? border;

  const syntaxComment = resolveOptional("syntaxComment") ?? textMuted;
  const syntaxKeyword = resolveOptional("syntaxKeyword") ?? secondary;
  const syntaxFunction = resolveOptional("syntaxFunction") ?? primary;
  const syntaxVariable = resolveOptional("syntaxVariable") ?? text;
  const syntaxString = resolveOptional("syntaxString") ?? success;
  const syntaxNumber = resolveOptional("syntaxNumber") ?? accent;
  const syntaxType = resolveOptional("syntaxType") ?? info;
  const syntaxOperator = resolveOptional("syntaxOperator") ?? text;
  const syntaxPunctuation = resolveOptional("syntaxPunctuation") ?? text;

  const overlayBackground = backgroundPanel.a === 255 ? backgroundPanel : opaqueBackground;
  const selection = { ...mix(opaqueBackground, primary, 0.35), a: 255 };
  const paneBackground = transparent || backgroundPanel.a === 0 ? TRANSPARENT : backgroundPanel;
  const background = transparent ? TRANSPARENT : rawBackground;

  return {
    name,
    mode,
    transparent,
    primary,
    secondary,
    accent,
    error,
    warning,
    success,
    info,
    text,
    textMuted,
    background,
    backgroundPanel,
    backgroundElement,
    border,
    borderActive,
    borderSubtle,
    syntaxComment,
    syntaxKeyword,
    syntaxFunction,
    syntaxVariable,
    syntaxString,
    syntaxNumber,
    syntaxType,
    syntaxOperator,
    syntaxPunctuation,
    paneBackground,
    overlayBackground,
    selection,
  };
}
