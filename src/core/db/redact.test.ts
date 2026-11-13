import { describe, expect, test } from "bun:test";
import { parseConnection } from "./connection";
import { redactConnectionInput, redactConnectionText, redactMessage } from "./redact";

describe("redactConnectionInput", () => {
  test("removes password containing /, ?, #, @, spaces and line breaks up to the last @", () => {
    const cases = [
      ["postgres://u:hun/ter2@h/db", "postgres://u@h/db"],
      ["postgres://u:hun?ter2@h/db", "postgres://u@h/db"],
      ["postgres://u:hun#ter2@h/db", "postgres://u@h/db"],
      ["postgres://u:hun ter2@h/db%zz", "postgres://u@h/db%zz"],
      ["postgres://u:hun\nter2@h/db", "postgres://u@h/db"],
      ["postgres://u:hun@ter2@h/db", "postgres://u@h/db"],
      ["mysql://u:hun/ter2@h/db", "mysql://u@h/db"],
      ["mysql://u:hun?ter2@h/db", "mysql://u@h/db"],
      ["mysql://u:hun#ter2@h/db", "mysql://u@h/db"],
      ["mysql://u:hun ter2@h/db%zz", "mysql://u@h/db%zz"],
      ["u:hun/ter2@h/db", "u@h/db"],
      ["u:hun?ter2@h/db", "u@h/db"],
      ["u:hun#ter2@h/db", "u@h/db"],
      ["u:hun ter2@h/db%zz", "u@h/db%zz"],
    ] as const;

    for (const [input, expected] of cases) {
      const out = redactConnectionInput(input);
      expect(out).toBe(expected);
      expect(out).not.toContain("hun");
      expect(out).not.toContain("ter2");
    }
  });

  test("returns input without @ unchanged except for password=", () => {
    expect(redactConnectionInput("postgres://localhost/db")).toBe("postgres://localhost/db");
    expect(redactConnectionInput("sqlite:/path/to/a:b.db")).toBe("sqlite:/path/to/a:b.db");
    expect(redactConnectionInput("postgres://h/db?password=hunter2&ssl=true")).toBe(
      "postgres://h/db?password=***&ssl=true",
    );
    expect(redactConnectionInput("host=h user=u password=hunter2 dbname=db")).toBe(
      "host=h user=u password=*** dbname=db",
    );
  });
});

describe("redactConnectionText", () => {
  test("removes password from user:password@ with or without scheme and handles multiple @", () => {
    expect(redactConnectionText("mysql://u:hunter2@h/db")).toBe("mysql://u@h/db");
    expect(redactConnectionText("postgresql+psycopg://u:hunter2@h/db")).toBe(
      "postgresql+psycopg://u@h/db",
    );
    expect(redactConnectionText("postgres:/u:hunter2@h/db")).toBe("postgres:/u@h/db");
    expect(redactConnectionText("Postgres://u:hunter2@h/db")).toBe("Postgres://u@h/db");
    expect(redactConnectionText("jdbc:postgresql://u:hunter2@h/db")).toBe(
      "jdbc:postgresql://u@h/db",
    );
    expect(redactConnectionText("u:hunter2@h/db")).toBe("u@h/db");
    expect(redactConnectionText("postgres://u:p@ss@h/db")).toBe("postgres://u@h/db");
    expect(redactConnectionText("postgres://u:hun@ter2@h/db%zz")).toBe("postgres://u@h/db%zz");
  });

  test("removes password containing /, ? or # inside a whitespace-delimited token", () => {
    expect(
      redactConnectionText(
        "failed on postgres://u:hun/ter2@h/db and mysql://u:hun?ter2@h/db or u:hun#ter2@h/db",
      ),
    ).toBe("failed on postgres://u@h/db and mysql://u@h/db or u@h/db");
  });

  test("replaces password= parameter values with ***", () => {
    expect(redactConnectionText("postgres://u@h/db?password=hunter2&x=%zz")).toBe(
      "postgres://u@h/db?password=***&x=%zz",
    );
    expect(redactConnectionText("host=h user=u password=hunter2 dbname=db")).toBe(
      "host=h user=u password=*** dbname=db",
    );
    expect(redactConnectionText("postgres://u:hunter2@h/db?sslmode=bogus&password=hunter2")).toBe(
      "postgres://u@h/db?sslmode=bogus&password=***",
    );
  });
});

describe("redactMessage", () => {
  test("does not garble message when password is a single character", () => {
    const msg = "syntax error at or near \"select\" in postgres://u:a@localhost:5432/db?password=a";
    const out = redactMessage(msg, {
      url: "postgres://u:a@localhost:5432/db?password=a",
      password: "a",
    });
    expect(out).toContain("syntax error at or near \"select\" in");
    expect(out).not.toContain(":a@");
    expect(out).not.toContain("password=a");
  });

  test("replaces :<password>@ and password=<password> even for short passwords", () => {
    const msg = "failed to connect to u:a@host with password=a";
    const out = redactMessage(msg, { password: "a" });
    expect(out).not.toContain(":a@");
    expect(out).not.toContain("password=a");
    expect(out).toContain("failed to connect to");
  });

  test("replaces bare occurrence when password has at least 8 characters", () => {
    const msg = "authentication failed for secret hunter22 in query";
    const out = redactMessage(msg, {
      url: "postgres://u:hunter22@localhost/db",
      password: "hunter22",
    });
    expect(out).not.toContain("hunter22");
    expect(out).toContain("authentication failed for secret *** in query");
  });

  test("replaces only what it knows and does not rewrite unrelated user:value@ patterns in server messages", () => {
    expect(redactMessage("Key (email)=(john:doe@example.com) already exists.", {})).toBe(
      "Key (email)=(john:doe@example.com) already exists.",
    );
    expect(
      redactMessage("Key (email)=(john:doe@example.com) already exists.", {
        url: "postgres://u:hunter22@localhost/db",
        password: "hunter22",
      }),
    ).toBe("Key (email)=(john:doe@example.com) already exists.");
  });

  test("does not eat ordinary duplicate-key message with : and later @", () => {
    const dupMsg = "ERROR: duplicate key … Key (email)=(john@example.com) already exists.";
    expect(redactConnectionText(dupMsg)).toBe(dupMsg);
    expect(redactMessage(dupMsg, {})).toBe(dupMsg);
  });
});

describe("redactConnectionInput and redactConnectionText around surrounding text", () => {
  test("redactConnectionInput cannot be bypassed by text around the URL", () => {
    const wrapped = [
      ["psql postgres://u:pw@h/db", "psql postgres://u@h/db", "pw"],
      ["export DATABASE_URL=postgres://u:secretpw@h/db", "export DATABASE_URL=postgres://u@h/db", "secretpw"],
      ["please use postgres://u:secretpw@h/db now", "please use postgres://u@h/db now", "secretpw"],
      ["psql postgresql://u:pw@h/db", "psql postgresql://u@h/db", "pw"],
      ["export DATABASE_URL=postgresql://u:secretpw@h/db", "export DATABASE_URL=postgresql://u@h/db", "secretpw"],
      ["please use postgresql://u:secretpw@h/db now", "please use postgresql://u@h/db now", "secretpw"],
      ["psql mysql://u:pw@h/db", "psql mysql://u@h/db", "pw"],
      ["export DATABASE_URL=mysql://u:secretpw@h/db", "export DATABASE_URL=mysql://u@h/db", "secretpw"],
      ["please use mysql://u:secretpw@h/db now", "please use mysql://u@h/db now", "secretpw"],
      ["psql POSTGRES://u:pw@h/db", "psql POSTGRES://u@h/db", "pw"],
      ["export DATABASE_URL=POSTGRES://u:secretpw@h/db", "export DATABASE_URL=POSTGRES://u@h/db", "secretpw"],
      ["please use POSTGRES://u:secretpw@h/db now", "please use POSTGRES://u@h/db now", "secretpw"],
      ["psql u:pw@h/db", "psql u@h/db", "pw"],
      ["u:hun ter2@h/db", "u@h/db", "hun"],
    ] as const;

    for (const [input, expected, secret] of wrapped) {
      const out = redactConnectionInput(input);
      expect(out).toBe(expected);
      expect(out).not.toContain(secret);
    }

    // Two URLs in one text, each with its own password
    const twoUrls =
      "primary=postgres://u1:firstsecret@h1/db1 replica=postgresql://u2:secondsecret@h2/db2";
    const twoOut = redactConnectionInput(twoUrls);
    expect(twoOut).toBe("primary=postgres://u1@h1/db1 replica=postgresql://u2@h2/db2");
    expect(twoOut).not.toContain("firstsecret");
    expect(twoOut).not.toContain("secondsecret");

    // URL followed by an email address: password is gone (more may be gone, which is fine)
    const urlAndEmail = "connect to postgres://u:mysecretpw@h/db or mail admin@example.com";
    const emailOut = redactConnectionInput(urlAndEmail);
    expect(emailOut).not.toContain("mysecretpw");
  });

  test("redactConnectionText redacts token where scheme is preceded by prefix like DATABASE_URL=", () => {
    const out = redactConnectionText("set DATABASE_URL=postgres://u:pw@h/db first");
    expect(out).toBe("set DATABASE_URL=postgres://u@h/db first");
    expect(out).not.toContain("pw");
  });

  test("property test: random texts with :<marker>@ after a :// never leak the marker in redactConnectionInput", () => {
    const marker = "MARK_SECRET_99";
    const pieces = [
      "postgres://",
      "u",
      ":",
      marker,
      "@",
      "h",
      "/",
      "?",
      "#",
      " ",
      "psql ",
      "x=",
    ];
    // Deterministic PRNG (mulberry32)
    let seed = 0x12345678;
    const rand = (max: number) => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % max;
    };

    const segmentHasColonMarkerBeforeAt = (text: string): boolean => {
      const re = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\//g;
      const matches = [...text.matchAll(re)];
      for (let mIdx = 0; mIdx < matches.length; mIdx++) {
        const m = matches[mIdx]!;
        const segStart = m.index! + m[0].length;
        const segEnd = mIdx + 1 < matches.length ? matches[mIdx + 1]!.index! : text.length;
        const seg = text.slice(segStart, segEnd);
        const lastAt = seg.lastIndexOf("@");
        if (lastAt !== -1) {
          const beforeAt = seg.slice(0, lastAt);
          const firstColon = beforeAt.indexOf(":");
          if (firstColon !== -1 && beforeAt.slice(firstColon).includes(marker)) {
            return true;
          }
        }
      }
      return false;
    };

    const nonMarkerPieces = ["postgres://", "u", ":", "@", "h", "/", "?", "#", " ", "psql ", "x="];
    let checkedWithMarker = 0;
    for (let i = 0; i < 4000; i++) {
      const len = 6 + rand(14);
      const chosen: string[] = [];
      let placedMarker = false;
      for (let j = 0; j < len; j++) {
        if (!placedMarker && j >= 2 && rand(3) === 0) {
          chosen.push("postgres://", "u", ":", marker, "@", "h");
          placedMarker = true;
        } else {
          chosen.push(nonMarkerPieces[rand(nonMarkerPieces.length)]!);
        }
      }
      const text = chosen.join("");
      if (segmentHasColonMarkerBeforeAt(text)) {
        const out = redactConnectionInput(text);
        expect(out).not.toContain(marker);
        checkedWithMarker++;
      }
    }
    expect(checkedWithMarker).toBeGreaterThan(2000);
  });

  test("redaction is fast on hostile backslash and escaped-quote inputs (< 50 ms) and redacts quoted passwords containing \\' and \\\\", () => {
    const millionBackslashes = `password='${"\\".repeat(1_000_000)}`;
    const millionEscapedQuotes = `password='${"\\'".repeat(1_000_000)}`;

    for (const fn of [redactConnectionInput, redactConnectionText]) {
      const t0 = performance.now();
      const out1 = fn(millionBackslashes);
      const elapsed1 = performance.now() - t0;
      expect(elapsed1).toBeLessThan(50);
      expect(out1.startsWith("password=***")).toBe(true);

      const t1 = performance.now();
      const out2 = fn(millionEscapedQuotes);
      const elapsed2 = performance.now() - t1;
      expect(elapsed2).toBeLessThan(50);
      expect(out2.startsWith("password=***")).toBe(true);
    }

    // Quoted passwords containing \' and \\ are redacted whole
    const singleQuoted = "host=h user=u password='sec\\'ret\\\\pw' dbname=db";
    expect(redactConnectionInput(singleQuoted)).toBe("host=h user=u password=*** dbname=db");
    expect(redactConnectionText(singleQuoted)).toBe("host=h user=u password=*** dbname=db");

    const doubleQuoted = 'host=h user=u password="sec\\"ret\\\\pw" dbname=db';
    expect(redactConnectionInput(doubleQuoted)).toBe("host=h user=u password=*** dbname=db");
    expect(redactConnectionText(doubleQuoted)).toBe("host=h user=u password=*** dbname=db");
  });
});


describe("pass= is a password in a URL query; password= wherever a password is hidden", () => {
  const spellings = [
    "pass=SECRET",
    "PASS=SECRET",
    "%70ass=SECRET",
    "pass%77ord=SECRET",
    "%50%41%53%53=SECRET",
    "p%61ss%77%6Frd=SECRET",
    "password=SECRET",
  ];

  test("each spelling of the key is hidden in a URL query, in both functions", () => {
    for (const spelling of spellings) {
      for (const fn of [redactConnectionInput, redactConnectionText]) {
        const url = `postgres://u@h:5432/db?port=x&${spelling}`;
        const out = fn(url);
        expect(out).not.toContain("SECRET");
        expect(out).toBe(url.replace("SECRET", "***"));
        const first = fn(`postgres://u@h/db?${spelling}&sslmode=require`);
        expect(first).not.toContain("SECRET");
        expect(first).toContain("&sslmode=require");
      }
    }
  });

  test("each spelling of password is hidden in the keyword form and with quoted values; pass is not a key there", () => {
    for (const spelling of spellings) {
      const key = spelling.slice(0, spelling.indexOf("="));
      const isPass = decodeURIComponent(key).toLowerCase() === "pass";
      // In the keyword form `pass` is not a key: the text stays as it is.
      const hidden = (input: string, expected: string) => (isPass ? input : expected);
      for (const fn of [redactConnectionInput, redactConnectionText]) {
        expect(fn(`host=h user=u ${key}=SECRET dbname=db`)).toBe(hidden(`host=h user=u ${key}=SECRET dbname=db`, `host=h user=u ${key}=*** dbname=db`));
        expect(fn(`host=h ${key} = SECRET dbname=db`)).toBe(hidden(`host=h ${key} = SECRET dbname=db`, `host=h ${key} = ***dbname=db`.replace("***dbname", "*** dbname")));
        expect(fn(`host=h ${key}='SEC RET' dbname=db`)).toBe(hidden(`host=h ${key}='SEC RET' dbname=db`, `host=h ${key}=*** dbname=db`));
        expect(fn(`host=h ${key}="SEC\\"RET" dbname=db`)).toBe(hidden(`host=h ${key}="SEC\\"RET" dbname=db`, `host=h ${key}=*** dbname=db`));
        expect(fn(`${key}=SECRET`)).toBe(hidden(`${key}=SECRET`, `${key}=***`));
      }
    }
  });

  test("the value stays hidden whatever its encoding", () => {
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      const out = fn("postgres://u@h/db?pass=%53%45%43%52%45%54&x=1");
      expect(out).toBe("postgres://u@h/db?pass=***&x=1");
    }
  });

  test("a word that merely ends in pass is not a password key; a key that cannot be decoded is compared as written", () => {
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      expect(fn("postgres://u@h/db?bypass=1&compass=north")).toBe("postgres://u@h/db?bypass=1&compass=north");
      expect(fn("bypass=1 compass=north passes=2 passwords=3")).toBe("bypass=1 compass=north passes=2 passwords=3");
      expect(fn("postgres://u@h/db?pa%zzss=1")).toBe("postgres://u@h/db?pa%zzss=1");
      expect(fn("postgres://u@h/db?pass%zz=1")).toBe("postgres://u@h/db?pass%zz=1");
    }
  });

  test("redactMessage hides pass=<password> like password=<password>", () => {
    expect(redactMessage("bad value in pass=pw1 here", { password: "pw1" })).toBe("bad value in pass=*** here");
  });
});

// The implementation of the previous round (commit 0bd6cea), kept as the reference for the agreement
// property below: it hid an unterminated quoted value only partly.
function oldRedactPasswordParams(input: string): string {
  const PASSWORD_PARAM_RE =
    /((?:^|[?&\s;])password\s*=\s*)(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[^\s&#;']*)/gi;
  const PASSWORD_PREFIX_RE = /(?:^|[?&\s;])password\s*=\s*/gi;
  const SINGLE_QUOTED_BODY_RE = /'(?:\\.|[^'\\])*/y;
  const DOUBLE_QUOTED_BODY_RE = /"(?:\\.|[^"\\])*/y;
  const BARE_PASSWORD_VAL_RE = /[^\s&#;']*/y;
  PASSWORD_PREFIX_RE.lastIndex = 0;
  let m = PASSWORD_PREFIX_RE.exec(input);
  if (!m) {
    return input.replace(PASSWORD_PARAM_RE, "$1***");
  }
  let out = "";
  let last = 0;
  while (m) {
    const valStart = PASSWORD_PREFIX_RE.lastIndex;
    let valEnd = valStart;
    const ch = input[valStart];
    if (ch === "'") {
      SINGLE_QUOTED_BODY_RE.lastIndex = valStart;
      SINGLE_QUOTED_BODY_RE.exec(input);
      const afterBody = SINGLE_QUOTED_BODY_RE.lastIndex;
      if (input[afterBody] === "'") {
        valEnd = afterBody + 1;
      }
    } else if (ch === '"') {
      DOUBLE_QUOTED_BODY_RE.lastIndex = valStart;
      DOUBLE_QUOTED_BODY_RE.exec(input);
      const afterBody = DOUBLE_QUOTED_BODY_RE.lastIndex;
      if (input[afterBody] === '"') {
        valEnd = afterBody + 1;
      } else {
        BARE_PASSWORD_VAL_RE.lastIndex = valStart;
        BARE_PASSWORD_VAL_RE.exec(input);
        valEnd = BARE_PASSWORD_VAL_RE.lastIndex;
      }
    } else {
      BARE_PASSWORD_VAL_RE.lastIndex = valStart;
      BARE_PASSWORD_VAL_RE.exec(input);
      valEnd = BARE_PASSWORD_VAL_RE.lastIndex;
    }
    out += `${input.slice(last, valStart)}***`;
    last = valEnd;
    PASSWORD_PREFIX_RE.lastIndex = valEnd;
    m = PASSWORD_PREFIX_RE.exec(input);
  }
  out += input.slice(last);
  return out;
}

function seededRandom(seed: number): (max: number) => number {
  let s = seed;
  return (max: number) => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % max;
  };
}

describe("an unterminated quoted password is hidden to its end", () => {
  test("hidden up to the end of the text or of the line, whichever comes first", () => {
    const cases: [string, string][] = [
      ["password='abc\\'def", "password=***"],
      ['password="abc\\"def', "password=***"],
      ["password='a\\'b\\'c\\\\d\\'e", "password=***"],
      ['password="a\\"b\\"c\\\\d\\"e', "password=***"],
      ["password='abc\\'def\nnext=1", "password=***\nnext=1"],
      ['password="abc\\"def\nnext=1', "password=***\nnext=1"],
      ["password='abc def ghi", "password=***"],
      ['password="abc def ghi', "password=***"],
      ["host=h password='abc\\'def dbname=db\nport=1", "host=h password=***\nport=1"],
      ["postgres://u@h/db?pass='abc\\'def", "postgres://u@h/db?pass=***"],
      ["postgres://u@h/db?password='abc\\'def&x=1", "postgres://u@h/db?password=***"],
    ];
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      for (const [input, expected] of cases) {
        const out = fn(input);
        expect(out).toBe(expected);
        expect(out).not.toContain("def");
        expect(out).not.toContain("ghi");
      }
    }
  });

  test("many unterminated quoted values on many lines stay linear", () => {
    // Each value stops at a backslash before the line break, so none closes on a later line.
    const manyLines = "password='x\\'y\\\n".repeat(100_000);
    const manyDouble = 'pass="x y\\\n'.repeat(100_000);
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      const t0 = performance.now();
      const out = fn(manyLines);
      const t1 = performance.now();
      const out2 = fn(manyDouble);
      const t2 = performance.now();
      expect(t1 - t0).toBeLessThan(500);
      expect(t2 - t1).toBeLessThan(500);
      expect(out).toBe("password=***\n".repeat(100_000));
      // `pass` is not a key in the keyword form: the text stays as it is.
      expect(out2).toBe(manyDouble);

      // One value that never closes, followed by many bare ones on later lines.
      const oneOpen = `password='abc\n${"password=x\n".repeat(100_000)}`;
      const t3 = performance.now();
      const out3 = fn(oneOpen);
      expect(performance.now() - t3).toBeLessThan(500);
      expect(out3).toBe(`password=***\n${"password=***\n".repeat(100_000)}`);
    }
  });

  test("the old and the new implementation agree on 200,000 seeded random texts, except where the old one showed part of a secret", () => {
    const pieces = [
      "password=",
      "password = ",
      "Password=",
      "'",
      '"',
      "\\",
      "\\'",
      '\\"',
      "\\\\",
      "X",
      "XY",
      " ",
      "\n",
      "&",
      ";",
      "#",
      "?",
      "host=h",
      "=",
      "\t",
    ];
    const rand = seededRandom(0x5eed_2b03);
    let differing = 0;
    let urlQueryDiffering = 0;
    for (let i = 0; i < 200_000; i++) {
      const len = 1 + rand(12);
      let text = "";
      for (let j = 0; j < len; j++) text += pieces[rand(pieces.length)]!;
      const old = oldRedactPasswordParams(text);
      for (const fn of [redactConnectionInput, redactConnectionText]) {
        const now = fn(text);
        if (now === old) continue;
        differing++;
        // Where they differ, the old output went on after a hidden value with text of the same line
        // (part of an unterminated quoted password) that the new output hides.
        let d = 0;
        while (d < old.length && d < now.length && old[d] === now[d]) d++;
        if (!old.slice(0, d).endsWith("***")) console.log(JSON.stringify({ text, old, now }));
        expect(old.slice(0, d).endsWith("***")).toBe(true);
        const oldLineRest = old.slice(d).split(/[\r\n]/, 1)[0]!;
        expect(oldLineRest.length).toBeGreaterThan(0);
        // Or: the value of a key directly after `?` or `&` is hidden up to the next `&`, `#`, whitespace
        // or the end, where the old one stopped before that, at `;` or `'` (or just after a closing quote,
        // which the Driver does not read as one in a URL query).
        const urlQueryValueWhole =
          /[?&]password\s*=\s*\*\*\*$/i.test(old.slice(0, d)) &&
          /^[^&#\s]/.test(old.slice(d)) &&
          /^($|[&#\s])/.test(now.slice(d));
        if (urlQueryValueWhole) urlQueryDiffering++;
        if (!(/^($|[\r\n])/.test(now.slice(d)) || urlQueryValueWhole)) console.log(JSON.stringify({ text, old, now }));
        expect(/^($|[\r\n])/.test(now.slice(d)) || urlQueryValueWhole).toBe(true);
      }
    }
    expect(differing).toBeGreaterThan(0);
    expect(urlQueryDiffering).toBeGreaterThan(0);
  });
});

/** The message `parseConnection` throws for `input`, or null when it accepts it. */
function parseMessage(input: string): string | null {
  try {
    parseConnection(input);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** What `parseConnection` shows of `input`: the message it throws, or the name and display it accepts it with. */
function parseShown(input: string): string {
  try {
    const c = parseConnection(input);
    return `${c.name}\n${c.display}`;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("a password in a URL is hidden whole", () => {
  test("parseConnection hides all of a password= value that holds ; or '", () => {
    const semi = parseMessage("postgres://u@h/db?port=x&password=a;SECRET")!;
    expect(semi).toContain("postgres://u@h/db?port=x&password=*** (");
    expect(semi).not.toContain("SECRET");
    const quote = parseMessage("postgres://u@h/db?port=x&password=a'SECRET")!;
    expect(quote).toContain("postgres://u@h/db?port=x&password=*** (");
    expect(quote).not.toContain("SECRET");
  });

  test("in a URL query the value runs to the next &, to a #, to whitespace or to the end", () => {
    const cases: [string, string][] = [
      ["postgres://u@h/db?password=a;SECRET&x=1", "postgres://u@h/db?password=***&x=1"],
      ["postgres://u@h/db?password=a'SECRET&x=1", "postgres://u@h/db?password=***&x=1"],
      ["postgres://u@h/db?x=1&password=a;SE'CR;ET#frag", "postgres://u@h/db?x=1&password=***#frag"],
      ["postgres://u@h/db?x=1&password=a;SECRET and more", "postgres://u@h/db?x=1&password=*** and more"],
      ["postgres://u@h/db?x=1&password=a;SECRET", "postgres://u@h/db?x=1&password=***"],
      ["postgres://u@h/db?password='a'SECRET&x=1", "postgres://u@h/db?password=***&x=1"],
      ['postgres://u@h/db?password="a"SECRET&x=1', "postgres://u@h/db?password=***&x=1"],
      ["postgres://u@h/db?pass=a;SECRET&x=1", "postgres://u@h/db?pass=***&x=1"],
      ["postgres://u@h/db?x=1&PASS=a'SECRET", "postgres://u@h/db?x=1&PASS=***"],
      ["postgres://u@h/db?%70ass=a;SECRET&x=1", "postgres://u@h/db?%70ass=***&x=1"],
      ["see db?password=a;SECRET&x=1 here", "see db?password=***&x=1 here"],
    ];
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      for (const [input, expected] of cases) {
        const out = fn(input);
        expect(out).toBe(expected);
        expect(out).not.toContain("SECRET");
      }
    }
  });

  test("in the keyword form the ends of a value stay as they are", () => {
    const cases: [string, string][] = [
      ["host=h password=a;b dbname=db", "host=h password=***;b dbname=db"],
      ["host=h password=a'b dbname=db", "host=h password=***'b dbname=db"],
      ["host=h;password=a&b;dbname=db", "host=h;password=***&b;dbname=db"],
      ["password=a#b", "password=***#b"],
      ["host=h\tpassword=ab\tdbname=db", "host=h\tpassword=***\tdbname=db"],
    ];
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      for (const [input, expected] of cases) {
        expect(fn(input)).toBe(expected);
      }
    }
  });

  test("pass is a key only directly after ? or &; in the keyword form and in running text it is not", () => {
    const unchanged = [
      "error near: select * from t where pass = 'x' and name = 'bob'",
      "where Pass = ANY(ARRAY['a','b'])",
      "pass=x",
      "host=h pass=x dbname=db",
      "host=h;pass=x;dbname=db",
      "host=h pass='x y' dbname=db",
    ];
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      for (const input of unchanged) {
        expect(fn(input)).toBe(input);
      }
      expect(fn("postgres://u@h/db?pass=x")).toBe("postgres://u@h/db?pass=***");
      expect(fn("postgres://u@h/db?a=1&pass=x")).toBe("postgres://u@h/db?a=1&pass=***");
      // password stays a key in running text.
      expect(fn("where password = 'x' and name = 'bob'")).toBe("where password = *** and name = 'bob'");
    }
  });

  test("sslpassword is hidden like password, in both forms", () => {
    const cases: [string, string][] = [
      ["postgres://u@h/db?sslpassword=a;SECRET&x=1", "postgres://u@h/db?sslpassword=***&x=1"],
      ["postgres://u@h/db?x=1&SSLPassword=a'SECRET", "postgres://u@h/db?x=1&SSLPassword=***"],
      ["postgres://u@h/db?ssl%70assword=SECRET&x=1", "postgres://u@h/db?ssl%70assword=***&x=1"],
      ["host=h sslpassword=SECRET dbname=db", "host=h sslpassword=*** dbname=db"],
      ["host=h sslpassword = 'SEC RET' dbname=db", "host=h sslpassword = *** dbname=db"],
      ["sslpassword=SECRET", "sslpassword=***"],
      ["host=h;sslpassword=SECRET;dbname=db", "host=h;sslpassword=***;dbname=db"],
    ];
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      for (const [input, expected] of cases) {
        const out = fn(input);
        expect(out).toBe(expected);
        expect(out).not.toContain("SECRET");
        expect(out).not.toContain("SEC RET");
      }
    }
    const parsed = parseMessage("postgres://u@h/db?port=x&sslpassword=a;SECRET")!;
    expect(parsed).not.toContain("SECRET");
  });

  test("an @ in a query password, and a password that looks like the start of a second URL, are hidden", () => {
    // The authority step takes the last @ for the end of the credentials; the rest of the value is hidden.
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      const out = fn("postgres://u@h:5432/db?port=x&pass=s;H@?zIF2b and then");
      expect(out).not.toContain("zIF");
      expect(out).not.toContain("s;H");
      expect(out).toEndWith(" and then");
    }
    expect(redactConnectionInput("postgres://u@h:5432/db?port=x&pass=s;H@?zIF2b and then")).toBe("postgres://u@h*** and then");
    // A password that begins with // or holds scheme:// is not a second URL.
    for (const input of [
      "postgres://u://Onk2R%P\"(kj@h:5432/db?port=x",
      "postgres://u:ab://cdSECRET@h:5432/db",
      "postgres://u:a=b://cdSECRET@h:5432/db",
      "postgres://u:a@b=c://dSECRET@h:5432/db",
    ]) {
      const out = redactConnectionInput(input);
      expect(out).toBe("postgres://u@h:5432/db" + (input.endsWith("?port=x") ? "?port=x" : ""));
      expect(redactConnectionText(input)).toBe(out);
    }
    // Two URLs, each after whitespace and with its credentials closed, stay two.
    expect(redactConnectionInput("a=postgres://u:p1@h1/d b=postgres://v:p2@h2/d")).toBe("a=postgres://u@h1/d b=postgres://v@h2/d");
  });

  test("unterminated double-quoted keyword values on many lines stay linear", () => {
    const manyDouble = 'password="x y\\\n'.repeat(100_000);
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      const t0 = performance.now();
      const out = fn(manyDouble);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(out).toBe("password=***\n".repeat(100_000));
    }
  });

  test("1,000,000 characters of URL query values stay fast", () => {
    const manySemis = `postgres://u@h/db?password=${";".repeat(1_000_000)}`;
    const manyKeys = `postgres://u@h/db?${"&password=a;b'c".repeat(70_000)}`;
    const manyQuoted = `postgres://u@h/db?${"&password='a".repeat(90_000)}`;
    const manySchemes = `postgres://u:${"a://".repeat(250_000)}@h/db`;
    for (const fn of [redactConnectionInput, redactConnectionText]) {
      let t0 = performance.now();
      expect(fn(manySemis)).toBe("postgres://u@h/db?password=***");
      expect(performance.now() - t0).toBeLessThan(200);
      t0 = performance.now();
      expect(fn(manyKeys)).toBe(`postgres://u@h/db?${"&password=***".repeat(70_000)}`);
      expect(performance.now() - t0).toBeLessThan(500);
      t0 = performance.now();
      // Each quoted value closes at the quote of the next one and then runs on to the next `&`.
      expect(fn(manyQuoted)).toBe(`postgres://u@h/db?${"&password=***".repeat(45_000)}`);
      expect(performance.now() - t0).toBeLessThan(500);
      t0 = performance.now();
      expect(fn(manySchemes)).toBe("postgres://u@h/db");
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });

  test("100,000 seeded random URLs: no part of the password of three or more characters is shown", () => {
    // All printable ASCII except &, # and whitespace.
    const alphabet = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).filter(
      (c) => c !== "&" && c !== "#",
    );
    const tails = ["", "&sslmode=require", "#frag", " and then"];
    const hint = 'unsupported connection:  (use a postgres:// URL, a SQLite file path, or "demo"; percent-encode special characters in the password)';
    const grams = (s: string) => {
      const out = new Set<string>();
      for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
      return out;
    };
    const rand = seededRandom(0x0b5e_c3e7);
    let checked = 0;
    let acceptedCount = 0;
    for (let i = 0; i < 100_000; i++) {
      let secret = "";
      const len = 3 + rand(14);
      for (let j = 0; j < len; j++) secret += alphabet[rand(alphabet.length)]!;
      const written = rand(2) === 0 ? secret : encodeURIComponent(secret);
      const place = rand(3);
      const tail = tails[rand(tails.length)]!;
      const build = (pw: string) =>
        place === 0
          ? `postgres://u:${pw}@h:5432/db?port=x${tail}`
          : `postgres://u@h:5432/db?port=x&${place === 1 ? "password" : "pass"}=${pw}${tail}`;
      const url = build(written);
      const ref = build("zz");
      const boiler = [redactConnectionInput(ref), redactConnectionText(ref), parseShown(ref), hint].join("\n");
      const check = (out: string, parts: string[]) => {
        for (const g of new Set(parts.flatMap((p) => [...grams(p)]))) {
          if (boiler.includes(g)) continue;
          checked++;
          if (out.includes(g)) console.log(JSON.stringify({ url, out, g }));
          expect(out.includes(g)).toBe(false);
        }
      };
      check(redactConnectionInput(url), [secret, written]);
      check(redactConnectionText(url), [secret, written]);
      let accepted: URL | null = null;
      try {
        parseConnection(url);
        accepted = new URL(url);
      } catch {}
      if (accepted === null) {
        check(parseShown(url), [secret, written]);
      } else {
        // Accepted: a raw `?` or `/` in the credentials ended the authority early, so the password the
        // Driver reads is the URL's, and what follows it is the host it connects to.
        let read = accepted.password;
        try {
          read = decodeURIComponent(read);
        } catch {}
        acceptedCount++;
        check(parseShown(url), [accepted.password, read]);
      }
    }
    expect(checked).toBeGreaterThan(1_000_000);
    // Nearly all are refused (the query holds port=x): the message is checked.
    expect(acceptedCount).toBeLessThan(5_000);
  }, 60_000);
});
