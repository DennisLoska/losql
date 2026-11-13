export interface Key {
  name: string;
  text?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

const SPECIAL_NAMES: Record<string, { name: string; text?: string }> = {
  esc: { name: "escape" },
  cr: { name: "enter" },
  bs: { name: "backspace" },
  tab: { name: "tab" },
  space: { name: "space", text: " " },
  lt: { name: "<", text: "<" },
  up: { name: "up" },
  down: { name: "down" },
  left: { name: "left" },
  right: { name: "right" },
  home: { name: "home" },
  end: { name: "end" },
  del: { name: "delete" },
  f1: { name: "f1" },
  f2: { name: "f2" },
  f3: { name: "f3" },
  f4: { name: "f4" },
  f5: { name: "f5" },
  f6: { name: "f6" },
  f7: { name: "f7" },
  f8: { name: "f8" },
  f9: { name: "f9" },
  f10: { name: "f10" },
  f11: { name: "f11" },
  f12: { name: "f12" },
};

function isAsciiLetter(ch: string): boolean {
  return ch.length === 1 && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"));
}

function isAsciiUpper(ch: string): boolean {
  return ch.length === 1 && ch >= "A" && ch <= "Z";
}

function literalKey(ch: string): Key {
  if (ch === " ") {
    return { name: "space", text: " " };
  }
  if (isAsciiUpper(ch)) {
    return { name: ch.toLowerCase(), text: ch, shift: true };
  }
  return { name: ch, text: ch };
}

function withModifiers(base: Key, ctrl: boolean, meta: boolean, shift: boolean): Key {
  const key: Key = { name: base.name };
  if (base.text !== undefined && !ctrl && !meta && !shift) {
    key.text = base.text;
  }
  if (ctrl) key.ctrl = true;
  if (meta) key.meta = true;
  if (shift) key.shift = true;
  return key;
}

function tryParseSpecial(notation: string, index: number): { key: Key; nextIndex: number } | null {
  const close = notation.indexOf(">", index + 1);
  if (close < 0) return null;
  let body = notation.slice(index + 1, close);
  if (body.length === 0) return null;

  let ctrl = false;
  let meta = false;
  let shift = false;
  let hasModifierPrefix = false;

  while (body.length > 2 && body[1] === "-") {
    const prefix = body[0]!.toLowerCase();
    if (prefix === "c") {
      ctrl = true;
      hasModifierPrefix = true;
      body = body.slice(2);
    } else if (prefix === "s") {
      shift = true;
      hasModifierPrefix = true;
      body = body.slice(2);
    } else if (prefix === "m") {
      meta = true;
      hasModifierPrefix = true;
      body = body.slice(2);
    } else {
      break;
    }
  }

  const lower = body.toLowerCase();
  const special = SPECIAL_NAMES[lower];
  if (special) {
    return {
      key: withModifiers(special, ctrl, meta, shift),
      nextIndex: close + 1,
    };
  }

  if (hasModifierPrefix && body.length === 1) {
    const ch = isAsciiLetter(body) ? body.toLowerCase() : body;
    return {
      key: withModifiers({ name: ch }, ctrl, meta, shift),
      nextIndex: close + 1,
    };
  }

  return null;
}

export function parseKeys(notation: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < notation.length) {
    if (notation[i] === "<") {
      const parsed = tryParseSpecial(notation, i);
      if (parsed) {
        keys.push(parsed.key);
        i = parsed.nextIndex;
        continue;
      }
    }
    const cp = notation.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    keys.push(literalKey(ch));
    i += ch.length;
  }
  return keys;
}

export function keyFromEvent(event: {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
}): Key {
  const { name, ctrl, meta, shift, sequence } = event;

  if (!ctrl && !meta && sequence.length > 0) {
    const cp = sequence.codePointAt(0)!;
    const cpLen = cp > 0xffff ? 2 : 1;
    if (sequence.length === cpLen && cp >= 0x20 && cp !== 0x7f) {
      return literalKey(sequence);
    }
  }

  if (name === "linefeed") {
    const key: Key = { name: "j", ctrl: true };
    if (meta) key.meta = true;
    if (shift) key.shift = true;
    return key;
  }

  let mappedName = name;
  if (name === "return") {
    mappedName = "enter";
  } else if (isAsciiUpper(name)) {
    mappedName = name.toLowerCase();
  }

  const key: Key = { name: mappedName };
  if (mappedName.length === 1 && !ctrl && !meta) {
    key.text = shift ? mappedName.toUpperCase() : mappedName;
  }
  if (ctrl) key.ctrl = true;
  if (meta) key.meta = true;
  if (shift) key.shift = true;
  return key;
}
