export function escapeControl(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) {
      out += "\n";
      i++;
      continue;
    }
    if (code === 0x0a || code === 0x09) {
      out += text[i]!;
      continue;
    }
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i]! + text[i + 1]!;
        i++;
      } else {
        out += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
      continue;
    }
    out += text[i]!;
  }
  return out;
}
