import { parseColor, SyntaxStyle } from "@opentui/core";

export const tokyoNightStyle = SyntaxStyle.fromStyles({
  // Strings
  string: { fg: parseColor("#9ece6a") },
  "string.special": { fg: parseColor("#9ece6a") },
  "string.escape": { fg: parseColor("#89ddff") },

  // Numbers and constants
  number: { fg: parseColor("#ff9e64") },
  constant: { fg: parseColor("#ff9e64") },
  "constant.builtin": { fg: parseColor("#ff9e64") },
  boolean: { fg: parseColor("#ff9e64") },

  // Punctuation
  "punctuation.bracket": { fg: parseColor("#a9b1d6") },
  "punctuation.delimiter": { fg: parseColor("#89ddff") },
  "punctuation.special": { fg: parseColor("#89ddff") },

  // Properties and fields
  property: { fg: parseColor("#7aa2f7") },
  "property.definition": { fg: parseColor("#7aa2f7") },
  field: { fg: parseColor("#7aa2f7") },

  // Keywords
  keyword: { fg: parseColor("#bb9af7") },
  "keyword.function": { fg: parseColor("#bb9af7") },
  "keyword.return": { fg: parseColor("#bb9af7") },
  "keyword.operator": { fg: parseColor("#89ddff") },
  "keyword.import": { fg: parseColor("#7dcfff") },
  "keyword.export": { fg: parseColor("#7dcfff") },

  // Comments
  comment: { fg: parseColor("#565f89"), italic: true },

  // Functions
  function: { fg: parseColor("#7aa2f7") },
  "function.method": { fg: parseColor("#7aa2f7") },
  "function.call": { fg: parseColor("#7aa2f7") },
  "function.builtin": { fg: parseColor("#7aa2f7") },
  method: { fg: parseColor("#7aa2f7") },

  // Variables
  variable: { fg: parseColor("#c0caf5") },
  "variable.builtin": { fg: parseColor("#f7768e") },
  "variable.parameter": { fg: parseColor("#e0af68") },
  "variable.member": { fg: parseColor("#7aa2f7") },
  parameter: { fg: parseColor("#e0af68") },

  // Operators
  operator: { fg: parseColor("#89ddff") },

  // Types
  type: { fg: parseColor("#2ac3de") },
  "type.builtin": { fg: parseColor("#2ac3de") },
  "type.definition": { fg: parseColor("#2ac3de") },
  constructor: { fg: parseColor("#2ac3de") },

  // Tags (for JSX/HTML)
  tag: { fg: parseColor("#f7768e") },
  "tag.attribute": { fg: parseColor("#bb9af7") },

  // Labels and special
  label: { fg: parseColor("#7dcfff") },
  namespace: { fg: parseColor("#7dcfff") },

  // Markdown
  "markup.heading": { fg: parseColor("#7aa2f7"), bold: true },
  "markup.heading.1": { fg: parseColor("#f7768e"), bold: true },
  "markup.heading.2": { fg: parseColor("#ff9e64"), bold: true },
  "markup.heading.3": { fg: parseColor("#e0af68"), bold: true },
  "markup.heading.4": { fg: parseColor("#9ece6a"), bold: true },
  "markup.heading.5": { fg: parseColor("#7dcfff"), bold: true },
  "markup.heading.6": { fg: parseColor("#bb9af7"), bold: true },
  "markup.bold": { fg: parseColor("#c0caf5"), bold: true },
  "markup.italic": { fg: parseColor("#c0caf5"), italic: true },
  "markup.strikethrough": { fg: parseColor("#565f89") },
  "markup.link": { fg: parseColor("#7dcfff"), underline: true },
  "markup.link.url": { fg: parseColor("#2ac3de"), underline: true },
  "markup.link.label": { fg: parseColor("#7aa2f7") },
  "markup.link.text": { fg: parseColor("#7dcfff") },
  "markup.list": { fg: parseColor("#89ddff") },
  "markup.list.checked": { fg: parseColor("#9ece6a") },
  "markup.list.unchecked": { fg: parseColor("#565f89") },
  "markup.quote": { fg: parseColor("#565f89"), italic: true },
  "markup.raw": { fg: parseColor("#9ece6a") },
  "markup.raw.inline": { fg: parseColor("#9ece6a") },
  "markup.raw.block": { fg: parseColor("#9ece6a") },

  // Text (fallback for markdown content)
  text: { fg: parseColor("#c0caf5") },
  "text.emphasis": { fg: parseColor("#c0caf5"), italic: true },
  "text.strong": { fg: parseColor("#c0caf5"), bold: true },
  "text.literal": { fg: parseColor("#9ece6a") },
  "text.uri": { fg: parseColor("#2ac3de"), underline: true },
  "text.reference": { fg: parseColor("#7aa2f7") },
  "text.title": { fg: parseColor("#7aa2f7"), bold: true },
});
