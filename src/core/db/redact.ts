/** Parameter names whose value is a password (compared after percent-decoding, ignoring case). */
const PASSWORD_KEYS = new Set(["password", "sslpassword"]);
/** Keys the Driver reads as a password only in a URL query. */
const URL_PASSWORD_KEYS = new Set(["pass"]);

/**
 * A parameter key (`key=` in a URL query or the keyword form): a delimiter or the start of the text,
 * then the whole parameter name. Key characters exclude every delimiter, so each start position only
 * scans up to the next delimiter and the scan stays linear.
 */
const PARAM_KEY_RE = /((?:^|[?&\s;])([^\s=?&;#'"]+))\s*=\s*/g;
const SINGLE_QUOTED_BODY_RE = /'(?:\\.|[^'\\])*/y;
const DOUBLE_QUOTED_BODY_RE = /"(?:\\.|[^"\\])*/y;
const BARE_PASSWORD_VAL_RE = /[^\s&#;']*/y;
const URL_QUERY_VAL_RE = /[^\s&#]*/y;
const LINE_END_RE = /[\r\n]/g;

function isPasswordKey(rawKey: string, inUrlQuery: boolean): boolean {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    // a key that cannot be decoded is compared as written
  }
  const lower = key.toLowerCase();
  return PASSWORD_KEYS.has(lower) || (inUrlQuery && URL_PASSWORD_KEYS.has(lower));
}

function lineEndFrom(input: string, from: number): number {
  LINE_END_RE.lastIndex = from;
  const m = LINE_END_RE.exec(input);
  return m ? m.index : input.length;
}

/**
 * The ranges of the password values in `input`, as `[start, end, start, end, ...]` in order. In a URL
 * query (the key directly after `?` or `&`) a value runs to the next `&`, `#`, whitespace or the end,
 * as the Driver reads it; in the keyword form a bare value also ends at `;` and `'`.
 */
function passwordValueRanges(input: string): number[] {
  const ranges: number[] = [];
  // Where a scan of a quoted body for each quote character stopped without finding its closing
  // quote. A later scan for the same quote character that starts before that point stops there too
  // (both scans are in step after the opening quote), so it is not repeated: this keeps the whole
  // pass linear even with many unterminated values.
  const unclosedUntil: Record<"'" | '"', number> = { "'": -1, '"': -1 };
  PARAM_KEY_RE.lastIndex = 0;
  let m = PARAM_KEY_RE.exec(input);
  while (m) {
    const valStart = PARAM_KEY_RE.lastIndex;
    const delimiter = input[m.index];
    const inUrlQuery = m[1]!.length > m[2]!.length && (delimiter === "?" || delimiter === "&");
    if (!isPasswordKey(m[2]!, inUrlQuery)) {
      // Not a password: go on right after the key, so the delimiter in front of a key that follows
      // (`a = password = v`) is seen again.
      PARAM_KEY_RE.lastIndex = m.index + m[1]!.length;
      m = PARAM_KEY_RE.exec(input);
      continue;
    }
    let valEnd: number;
    const ch = input[valStart];
    if (ch === "'" || ch === '"') {
      let closedAt = -1;
      if (valStart >= unclosedUntil[ch]) {
        const body = ch === "'" ? SINGLE_QUOTED_BODY_RE : DOUBLE_QUOTED_BODY_RE;
        body.lastIndex = valStart;
        body.exec(input);
        const afterBody = body.lastIndex;
        if (input[afterBody] === ch) {
          closedAt = afterBody;
        } else {
          unclosedUntil[ch] = afterBody;
        }
      }
      // A quoted value that does not close is hidden up to the end of the line or of the text.
      valEnd = closedAt !== -1 ? closedAt + 1 : lineEndFrom(input, valStart);
      if (inUrlQuery) {
        // The Driver does not read quotes in a URL query: whatever follows the closing quote up to the
        // next `&`, `#` or whitespace is part of the value too.
        URL_QUERY_VAL_RE.lastIndex = valEnd;
        URL_QUERY_VAL_RE.exec(input);
        valEnd = URL_QUERY_VAL_RE.lastIndex;
      }
    } else if (inUrlQuery) {
      URL_QUERY_VAL_RE.lastIndex = valStart;
      URL_QUERY_VAL_RE.exec(input);
      valEnd = URL_QUERY_VAL_RE.lastIndex;
    } else {
      BARE_PASSWORD_VAL_RE.lastIndex = valStart;
      BARE_PASSWORD_VAL_RE.exec(input);
      valEnd = BARE_PASSWORD_VAL_RE.lastIndex;
    }
    ranges.push(valStart, valEnd);
    PARAM_KEY_RE.lastIndex = valEnd;
    m = PARAM_KEY_RE.exec(input);
  }
  return ranges;
}

function redactPasswordParams(input: string): string {
  const ranges = passwordValueRanges(input);
  let out = "";
  let last = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    out += `${input.slice(last, ranges[i]!)}***`;
    last = ranges[i + 1]!;
  }
  out += input.slice(last);
  return out;
}

/**
 * `text` without the credentials from `start` up to the `@` at `at`. When the key of a password
 * parameter lies in that part and its value runs on past that `@` (an `@` in a query value, taken for
 * the end of the credentials), the rest of the value is hidden too: with its key removed, nothing
 * else would hide it.
 */
function withoutCredentials(text: string, start: number, at: number): string {
  const ranges = passwordValueRanges(text);
  for (let i = 0; i < ranges.length && ranges[i]! <= at; i += 2) {
    if (ranges[i]! >= start && ranges[i + 1]! > at) {
      return `${text.slice(0, start)}***${text.slice(ranges[i + 1]!)}`;
    }
  }
  return `${text.slice(0, start)}${text.slice(at)}`;
}

const SCHEME_SLASHES_GLOBAL_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\//g;

function redactSegmentAfterScheme(segment: string): string {
  const lastAt = segment.lastIndexOf("@");
  if (lastAt === -1) {
    return segment;
  }
  const beforeAt = segment.slice(0, lastAt);
  const firstColon = beforeAt.indexOf(":");
  if (firstColon === -1) {
    return segment;
  }
  return withoutCredentials(segment, firstColon, lastAt);
}

/**
 * The `scheme://` matches in `input` that begin a URL. One that follows the start of the URL before
 * it with no whitespace in between, or while that URL's `user:` is not yet closed by an `@`, lies in
 * its credentials (a password such as `//x` or `a=b://c`) and is part of them.
 */
function urlStarts(input: string): RegExpMatchArray[] {
  const starts: RegExpMatchArray[] = [];
  let whitespace = false;
  let colon = false;
  let at = false;
  let scanned = 0;
  for (const m of input.matchAll(SCHEME_SLASHES_GLOBAL_RE)) {
    if (starts.length > 0) {
      for (let i = scanned; i < m.index!; i++) {
        const c = input[i]!;
        if (c === ":") colon = true;
        else if (c === "@") at = true;
        else if (/\s/.test(c)) whitespace = true;
      }
      scanned = m.index!;
      if (!whitespace || (colon && !at)) continue;
    }
    starts.push(m);
    whitespace = colon = at = false;
    scanned = m.index! + m[0].length;
  }
  return starts;
}

function redactWholeInputWithOrWithoutScheme(input: string): string {
  const matches = urlStarts(input);
  if (matches.length > 0) {
    let out = input.slice(0, matches[0]!.index!);
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      const schemeToken = m[0];
      const segStart = m.index! + schemeToken.length;
      const segEnd = i + 1 < matches.length ? matches[i + 1]!.index! : input.length;
      const segment = input.slice(segStart, segEnd);
      out += schemeToken + redactSegmentAfterScheme(segment);
    }
    return out;
  }

  const lastAt = input.lastIndexOf("@");
  if (lastAt === -1) {
    return input;
  }

  let prefixLen = 0;
  const singleSlashScheme = input.match(/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)+\//);
  if (singleSlashScheme) {
    prefixLen = singleSlashScheme[0].length;
  }

  if (lastAt < prefixLen) {
    return input;
  }

  const beforeAt = input.slice(prefixLen, lastAt);
  const firstColon = beforeAt.indexOf(":");
  if (firstColon === -1) {
    return input;
  }

  return withoutCredentials(input, prefixLen + firstColon, lastAt);
}

function redactAuthorityToken(token: string): string {
  const lastAt = token.lastIndexOf("@");
  if (lastAt === -1) {
    return token;
  }

  let prefixLen = 0;
  const schemeInToken = token.match(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  if (schemeInToken && schemeInToken.index !== undefined) {
    prefixLen = schemeInToken.index + schemeInToken[0].length;
  } else {
    const schemeMatch = token.match(/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)+\//);
    if (schemeMatch) {
      prefixLen = schemeMatch[0].length;
    }
  }

  if (lastAt < prefixLen) {
    return token;
  }

  const beforeAt = token.slice(prefixLen, lastAt);
  const firstColon = beforeAt.indexOf(":");
  if (firstColon === -1) {
    return token;
  }

  const user = beforeAt.slice(0, firstColon);
  if (/[/?#\s]/.test(user)) {
    return token;
  }

  return withoutCredentials(token, prefixLen + firstColon, lastAt);
}

export function redactConnectionInput(input: string): string {
  const out = redactWholeInputWithOrWithoutScheme(input);
  return redactPasswordParams(out);
}

export function redactConnectionText(text: string): string {
  const out = text.replace(/\S+/g, (token) => redactAuthorityToken(token));
  return redactPasswordParams(out);
}


export function redactMessage(
  message: string,
  secrets: { url?: string; password?: string },
): string {
  let out = message;
  const { url, password } = secrets;
  if (url) {
    out = out.replaceAll(url, redactConnectionInput(url));
  }
  if (password) {
    const variants = new Set<string>([password]);
    try {
      variants.add(decodeURIComponent(password));
    } catch {
      // ignore malformed URI component
    }
    try {
      variants.add(encodeURIComponent(password));
    } catch {
      // ignore
    }
    for (const pw of variants) {
      if (!pw) continue;
      out = out.replaceAll(`:${pw}@`, "@");
      out = out.replaceAll(`password=${pw}`, "password=***");
      out = out.replaceAll(`pass=${pw}`, "pass=***");
      if (pw.length >= 8) {
        out = out.replaceAll(pw, "***");
      }
    }
  }
  return out;
}

