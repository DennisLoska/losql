import { type CliRenderer, RGBA, type StyleDefinitionInput, SyntaxStyle } from "@opentui/core";
import type { SyntaxRole } from "../core/sql/highlight";
import type { Rgba, Theme } from "../core/theme/tokens";

export function toRGBA(color: Rgba): RGBA {
  return RGBA.fromInts(color.r, color.g, color.b, color.a);
}

export function createSyntaxStyle(theme: Theme, renderer: CliRenderer): SyntaxStyle {
  const opaqueBackground: Rgba = { ...theme.background, a: 255 };

  const roleStyles: Record<SyntaxRole, StyleDefinitionInput> = {
    keyword: { fg: toRGBA(theme.syntaxKeyword) },
    function: { fg: toRGBA(theme.syntaxFunction) },
    variable: { fg: toRGBA(theme.syntaxVariable) },
    string: { fg: toRGBA(theme.syntaxString) },
    number: { fg: toRGBA(theme.syntaxNumber) },
    type: { fg: toRGBA(theme.syntaxType) },
    operator: { fg: toRGBA(theme.syntaxOperator) },
    punctuation: { fg: toRGBA(theme.syntaxPunctuation) },
    comment: { fg: toRGBA(theme.syntaxComment) },
    text: { fg: toRGBA(theme.text) },
  };

  const styles: Record<string, StyleDefinitionInput> = {
    ...roleStyles,
    search: {
      bg: toRGBA(theme.warning),
      fg: toRGBA(opaqueBackground),
    },
    error: {
      fg: toRGBA(theme.error),
      underline: true,
    },
    flash: {
      bg: toRGBA(theme.selection),
    },
  };

  return SyntaxStyle.fromStyles(styles, renderer.nativeScene);
}
