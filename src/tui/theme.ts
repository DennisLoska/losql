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
});
