export interface PrintableOptions {
  keepNewlines?: boolean;
  keepTabs?: boolean;
}

/**
 * Replaces C0 control characters, DEL and C1 control characters with the visible
 * replacement character U+FFFD, while turning line breaks and tabs into spaces
 * unless the caller opts to keep them.
 */
export function printable(text: string, options?: PrintableOptions): string {
  let out = options?.keepNewlines
    ? text.replace(/\r\n|\r|\u2028|\u2029/g, "\n")
    : text.replace(/\r\n|\r|\n|\u2028|\u2029/g, " ");
  if (!options?.keepTabs) {
    out = out.replace(/\t/g, " ");
  }
  return out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "\ufffd");
}
