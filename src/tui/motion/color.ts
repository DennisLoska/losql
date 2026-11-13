import { mix } from "../../core/theme/color";
import type { Theme } from "../../core/theme/tokens";

export function mixTheme(from: Theme, to: Theme, t: number): Theme {
  if (t >= 1) return to;
  const clamped = Math.max(0, t);
  return {
    name: to.name,
    mode: to.mode,
    transparent: to.transparent,
    primary: mix(from.primary, to.primary, clamped),
    secondary: mix(from.secondary, to.secondary, clamped),
    accent: mix(from.accent, to.accent, clamped),
    error: mix(from.error, to.error, clamped),
    warning: mix(from.warning, to.warning, clamped),
    success: mix(from.success, to.success, clamped),
    info: mix(from.info, to.info, clamped),
    text: mix(from.text, to.text, clamped),
    textMuted: mix(from.textMuted, to.textMuted, clamped),
    background: mix(from.background, to.background, clamped),
    backgroundPanel: mix(from.backgroundPanel, to.backgroundPanel, clamped),
    backgroundElement: mix(from.backgroundElement, to.backgroundElement, clamped),
    border: mix(from.border, to.border, clamped),
    borderActive: mix(from.borderActive, to.borderActive, clamped),
    borderSubtle: mix(from.borderSubtle, to.borderSubtle, clamped),
    syntaxComment: mix(from.syntaxComment, to.syntaxComment, clamped),
    syntaxKeyword: mix(from.syntaxKeyword, to.syntaxKeyword, clamped),
    syntaxFunction: mix(from.syntaxFunction, to.syntaxFunction, clamped),
    syntaxVariable: mix(from.syntaxVariable, to.syntaxVariable, clamped),
    syntaxString: mix(from.syntaxString, to.syntaxString, clamped),
    syntaxNumber: mix(from.syntaxNumber, to.syntaxNumber, clamped),
    syntaxType: mix(from.syntaxType, to.syntaxType, clamped),
    syntaxOperator: mix(from.syntaxOperator, to.syntaxOperator, clamped),
    syntaxPunctuation: mix(from.syntaxPunctuation, to.syntaxPunctuation, clamped),
    paneBackground: mix(from.paneBackground, to.paneBackground, clamped),
    overlayBackground: mix(from.overlayBackground, to.overlayBackground, clamped),
    selection: mix(from.selection, to.selection, clamped),
  };
}
