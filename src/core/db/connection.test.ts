import { describe, expect, test } from "bun:test";
import { ConnectionError, parseConnection } from "./connection";
import { redactConnectionInput, redactConnectionText } from "./redact";

const exists = (path: string) => path === "/work/app.db" || path === "/work/data/notes";

describe("parseConnection", () => {
  test("postgres URLs", () => {
    expect(parseConnection("postgres://app:s3cret@db.example.com:5433/shop?sslmode=require")).toEqual({
      id: "postgres-app-db-example-com-5433-shop",
      name: "shop",
      dialect: "postgres",
      url: "postgres://app:s3cret@db.example.com:5433/shop?sslmode=require",
      display: "postgres://app@db.example.com:5433/shop",
    });
    expect(parseConnection("postgresql://localhost/dev").display).toBe("postgres://localhost:5432/dev");
  });

  test("the display form never contains the password", () => {
    const c = parseConnection("postgres://u:hunter2@h/db");
    expect(c.display).not.toContain("hunter2");
    expect(c.id).not.toContain("hunter2");
  });

  test("sqlite forms", () => {
    expect(parseConnection("sqlite:app.db", { cwd: "/work", exists })).toEqual({
      id: "sqlite-work-app-db", name: "app.db", dialect: "sqlite", url: "sqlite:/work/app.db", display: "/work/app.db",
    });
    expect(parseConnection("sqlite:///work/app.db", { exists }).display).toBe("/work/app.db");
    expect(parseConnection("file:/work/app.db", { exists }).display).toBe("/work/app.db");
    expect(parseConnection("./app.db", { cwd: "/work", exists }).display).toBe("/work/app.db");
    expect(parseConnection("data/notes", { cwd: "/work", exists }).display).toBe("/work/data/notes");
  });

  test("a bare path that does not exist is still a sqlite connection when it has a database extension", () => {
    expect(parseConnection("new.sqlite3", { cwd: "/work", exists }).dialect).toBe("sqlite");
  });

  test("memory and demo", () => {
    expect(parseConnection(":memory:")).toEqual({ id: "memory", name: "memory", dialect: "sqlite", url: ":memory:", display: ":memory:" });
    expect(parseConnection("demo")).toEqual({ id: "demo", name: "demo", dialect: "sqlite", url: "demo", display: "demo" });
  });

  test("a given name is used for the name and the id", () => {
    const c = parseConnection("postgres://localhost/dev", { name: "Dev DB" });
    expect(c.name).toBe("Dev DB");
    expect(c.id).toBe("dev-db");
  });

  test("unrecognized input is an error", () => {
    expect(() => parseConnection("mysql://h/db")).toThrow(ConnectionError);
    expect(() => parseConnection("mysql://h/db")).toThrow("unsupported connection: mysql://h/db (use a postgres:// URL, a SQLite file path, or \"demo\")");
    expect(() => parseConnection("nothing-here", { cwd: "/work", exists })).toThrow(ConnectionError);
    expect(() => parseConnection("")).toThrow("empty connection");
  });

  test("a malformed percent-escape is a Connection error", () => {
    expect(() => parseConnection("postgres://a%zz@h/db")).toThrow(ConnectionError);
    expect(() => parseConnection("postgres://a%zz:s3cret@h/db")).toThrow(ConnectionError);
    try {
      parseConnection("postgres://a%zz:s3cret@h/db");
    } catch (err) {
      expect((err as Error).message).not.toContain("s3cret");
    }
  });

  test("case-insensitive postgres scheme is recognized and redacted", () => {
    const c = parseConnection("Postgres://u:hunter2@h/db");
    expect(c.dialect).toBe("postgres");
    expect(c.display).toBe("postgres://u@h:5432/db");
    expect(c.display).not.toContain("hunter2");
    expect(c.name).not.toContain("hunter2");
    expect(c.id).not.toContain("hunter2");

    const c2 = parseConnection("POSTGRESQL://u:hunter2@h/db");
    expect(c2.dialect).toBe("postgres");
    expect(c2.url.startsWith("postgres://")).toBe(true);
    expect(c2.display).not.toContain("hunter2");
  });

  test("no error message or connection ever leaks a password", () => {
    const inputs = [
      "mysql://u:hunter2@h/db",
      "postgresql+psycopg://u:hunter2@h/db",
      "postgres:/u:hunter2@h/db",
      "Postgres://u:hunter2@h/db",
      "jdbc:postgresql://u:hunter2@h/db",
      "u:hunter2@h/db",
      "postgres://u:hun@ter2@h/db%zz",
      "postgres://u@h/db?password=hunter2&x=%zz",
      "postgres://u:hunter2@h/db?sslmode=bogus&password=hunter2",
    ];
    for (const input of inputs) {
      try {
        const conn = parseConnection(input);
        expect(conn.display).not.toContain("hunter2");
        expect(conn.display).not.toContain("ter2");
        expect(conn.name).not.toContain("hunter2");
        expect(conn.name).not.toContain("ter2");
        expect(conn.id).not.toContain("hunter2");
        expect(conn.id).not.toContain("ter2");
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        const msg = (err as Error).message;
        expect(msg).not.toContain("hunter2");
        expect(msg).not.toContain("ter2");
      }
    }
  });

  test("a connection id is never empty, is deterministic, and differs for distinct non-ASCII or symbol names", () => {
    const c1 = parseConnection("demo", { name: "データ" });
    const c1Again = parseConnection("demo", { name: "データ" });
    const c2 = parseConnection("demo", { name: "!!!" });
    const c3 = parseConnection(":memory:", { name: "データ" });

    expect(c1.id.length).toBeGreaterThan(0);
    expect(c2.id.length).toBeGreaterThan(0);
    expect(c1.id).toBe(c1Again.id);
    expect(c3.id).toBe(c1.id);
    expect(c1.id).not.toBe(c2.id);
  });

  test("passwords with unencoded /, ?, # or space are never echoed in error or connection fields", () => {
    const rawShapes = [
      "u:hun/ter2@h/db",
      "u:hun?ter2@h/db",
      "u:hun#ter2@h/db",
      "u:hun ter2@h/db%zz",
    ];
    const prefixes = ["postgres://", "mysql://", ""];
    for (const prefix of prefixes) {
      for (const shape of rawShapes) {
        const input = `${prefix}${shape}`;
        try {
          const conn = parseConnection(input);
          for (const field of [conn.name, conn.id, conn.display]) {
            expect(field).not.toContain("hun");
            expect(field).not.toContain("ter2");
          }
        } catch (err) {
          expect(err).toBeInstanceOf(ConnectionError);
          const msg = (err as Error).message;
          expect(msg).not.toContain("hun");
          expect(msg).not.toContain("ter2");
        }
      }
    }
  });

  test("a valid Postgres URL is accepted whatever follows its credentials, while ambiguous unencoded credentials are rejected with hint", () => {
    const validCases = [
      {
        input: "postgres://u:pw@h/db?application_name=me@x",
        expectedDisplay: "postgres://u@h:5432/db",
        expectedName: "db",
        secrets: ["pw"],
      },
      {
        input: "postgres://u:pw@h/a@b",
        expectedDisplay: "postgres://u@h:5432/a@b",
        expectedName: "a@b",
        secrets: ["pw"],
      },
      {
        input: "postgres://u:p%40w@h/db?x=a@b",
        expectedDisplay: "postgres://u@h:5432/db",
        expectedName: "db",
        secrets: ["p@w", "p%40w"],
      },
      {
        input: "postgres://u@h/db?password=sec%20ret&x=1",
        expectedDisplay: "postgres://u@h:5432/db",
        expectedName: "db",
        secrets: ["sec"],
      },
    ];

    for (const { input, expectedDisplay, expectedName, secrets } of validCases) {
      const c = parseConnection(input);
      expect(c.dialect).toBe("postgres");
      expect(c.display).toBe(expectedDisplay);
      expect(c.name).toBe(expectedName);
      expect(new URL(c.url).hostname).toBe("h");
      expect(new URL(c.url).username).toBe("u");
      expect(decodeURIComponent(new URL(c.url).pathname.replace(/^\/+/, ""))).toBe(expectedName);
      for (const secret of secrets) {
        expect(c.display).not.toContain(secret);
        expect(c.name).not.toContain(secret);
        expect(c.id).not.toContain(secret);
      }
    }

    const rejectedShapes = [
      "postgres://u:hun/ter2@h/db",
      "postgres://u:hun?ter2@h/db",
      "postgres://u:hun#ter2@h/db",
      "postgres://u:12/ter2@h/db",
      "postgres://u:hun ter2@h/db",
    ];
    for (const bad of rejectedShapes) {
      let caught: unknown;
      try {
        parseConnection(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConnectionError);
      const msg = (caught as Error).message;
      expect(msg).not.toContain("hun");
      expect(msg).not.toContain("ter2");
      expect(msg).not.toContain("12/ter2");
    }

    // Specifically verify the hint on the ambiguity case (e.g. u:12/ter2@h/db parses as host u, port 12, empty user/password, with @ after //)
    expect(() => parseConnection("postgres://u:12/ter2@h/db")).toThrow(
      "percent-encode special characters in the password",
    );
  });

  test("redaction for display cannot be bypassed by text around the URL, while SQLite file paths keep their exact path", () => {
    const wrappedInputs = [
      ["psql postgres://u:pw@h/db", "pw"],
      ["export DATABASE_URL=postgres://u:secretpw@h/db", "secretpw"],
      ["please use postgres://u:secretpw@h/db now", "secretpw"],
      ["psql postgresql://u:pw@h/db", "pw"],
      ["export DATABASE_URL=postgresql://u:secretpw@h/db", "secretpw"],
      ["please use postgresql://u:secretpw@h/db now", "secretpw"],
      ["psql mysql://u:pw@h/db", "pw"],
      ["export DATABASE_URL=mysql://u:secretpw@h/db", "secretpw"],
      ["please use mysql://u:secretpw@h/db now", "secretpw"],
      ["psql POSTGRES://u:pw@h/db", "pw"],
      ["export DATABASE_URL=POSTGRES://u:secretpw@h/db", "secretpw"],
      ["please use POSTGRES://u:secretpw@h/db now", "secretpw"],
    ] as const;

    for (const [input, secret] of wrappedInputs) {
      let caught: unknown;
      try {
        parseConnection(input, { cwd: "/cwd", exists: () => false });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConnectionError);
      expect((caught as Error).message).not.toContain(secret);
    }

    const sqlite1 = parseConnection("./a:b@c.sqlite", { cwd: "/cwd" });
    expect(sqlite1.dialect).toBe("sqlite");
    expect(sqlite1.url).toBe("sqlite:/cwd/a:b@c.sqlite");
    expect(sqlite1.display).toBe("/cwd/a:b@c.sqlite");
    expect(sqlite1.name).toBe("a:b@c.sqlite");

    const sqlite2 = parseConnection("u:hun/ter2@h/db.db", { cwd: "/cwd" });
    expect(sqlite2.dialect).toBe("sqlite");
    expect(sqlite2.url).toBe("sqlite:/cwd/u:hun/ter2@h/db.db");
    expect(sqlite2.display).toBe("/cwd/u:hun/ter2@h/db.db");
    expect(sqlite2.name).toBe("db.db");
  });

  test("Postgres Connection display, name, and id reflect the effective target from authority and query parameters", () => {
    const table: {
      url: string;
      display: string;
      name: string;
      id: string;
    }[] = [
      {
        url: "postgres://losql@127.0.0.1:54329/postgres?host=other.example",
        display: "postgres://losql@other.example:5432/postgres",
        name: "postgres",
        id: "postgres-losql-other-example-5432-postgres",
      },
      {
        url: "postgres://losql@127.0.0.1:54329/postgres?port=5555",
        display: "postgres://losql@127.0.0.1:5555/postgres",
        name: "postgres",
        id: "postgres-losql-127-0-0-1-5555-postgres",
      },
      {
        url: "postgres://losql@127.0.0.1:54329/postgres?user=other",
        display: "postgres://other@127.0.0.1:54329/postgres",
        name: "postgres",
        id: "postgres-other-127-0-0-1-54329-postgres",
      },
      {
        url: "postgres://losql@127.0.0.1:54329/postgres?username=other2",
        display: "postgres://other2@127.0.0.1:54329/postgres",
        name: "postgres",
        id: "postgres-other2-127-0-0-1-54329-postgres",
      },
      {
        url: "postgres://losql@127.0.0.1:54329/postgres?database=altdb",
        display: "postgres://losql@127.0.0.1:54329/altdb",
        name: "altdb",
        id: "postgres-losql-127-0-0-1-54329-altdb",
      },
      {
        url: "postgres://losql@127.0.0.1:54329/postgres?db=altdb2",
        display: "postgres://losql@127.0.0.1:54329/altdb2",
        name: "altdb2",
        id: "postgres-losql-127-0-0-1-54329-altdb2",
      },
      {
        url: "postgres://losql@127.0.0.1:54329/postgres?dbname=ignored_by_client",
        display: "postgres://losql@127.0.0.1:54329/postgres",
        name: "postgres",
        id: "postgres-losql-127-0-0-1-54329-postgres",
      },
      {
        url: "postgres://wronguser@wrong.example:9999/wrongdb?host=127.0.0.1&port=54329&user=losql&database=postgres&password=s3cr%2Bet",
        display: "postgres://losql@127.0.0.1:54329/postgres",
        name: "postgres",
        id: "postgres-losql-127-0-0-1-54329-postgres",
      },
      {
        url: "postgres://u@127.0.0.1:54329/db?host=h.example:6543",
        display: "postgres://u@h.example:6543/db",
        name: "db",
        id: "postgres-u-h-example-6543-db",
      },
      {
        url: "postgres://u@127.0.0.1:54329/db?host=h.example:6543&port=7777",
        display: "postgres://u@h.example:7777/db",
        name: "db",
        id: "postgres-u-h-example-7777-db",
      },
      {
        url: "postgres://u+1@h/db+1?user=u+2&database=db+2&host=h+2",
        display: "postgres://u+2@h+2:5432/db+2",
        name: "db+2",
        id: "postgres-u-2-h-2-5432-db-2",
      },
      {
        url: "postgres://u@h/db?user=a%2Bb&database=c%20d",
        display: "postgres://a+b@h:5432/c d",
        name: "c d",
        id: "postgres-a-b-h-5432-c-d",
      },
      {
        url: "postgres://losql@127.0.0.1:54329/postgres?host=/run/postgresql",
        display: "postgres://losql@/run/postgresql:5432/postgres",
        name: "postgres",
        id: "postgres-losql-run-postgresql-5432-postgres",
      },
    ];

    for (const row of table) {
      const c = parseConnection(row.url);
      expect(c.display).toBe(row.display);
      expect(c.name).toBe(row.name);
      expect(c.id).toBe(row.id);
      expect(c.display).not.toContain("s3cr");
      expect(c.name).not.toContain("s3cr");
      expect(c.id).not.toContain("s3cr");
    }

    // Invalid port or multi-host where effective single target cannot be determined
    expect(() => parseConnection("postgres://u@h/db?port=notaport")).toThrow(ConnectionError);
    expect(() => parseConnection("postgres://u@h/db?port=70000")).toThrow(ConnectionError);
    expect(() => parseConnection("postgres://u@h/db?host=h1,h2")).toThrow(ConnectionError);
  });
});




const SECRET_SPELLINGS = (secret: string) => [
  { where: "authority", put: (base: string) => base.replace("://u@", `://u:${secret}@`), query: "" },
  { where: "password=", put: (base: string) => base, query: `password=${secret}` },
  { where: "pass=", put: (base: string) => base, query: `pass=${secret}` },
  { where: "%70ass=", put: (base: string) => base, query: `%70ass=${secret}` },
  { where: "pass%77ord=", put: (base: string) => base, query: `pass%77ord=${secret}` },
  { where: "PASS=", put: (base: string) => base, query: `PASS=${secret}` },
];

// Every way parseConnection rejects a postgres:// URL; `?` is followed by the parameters of the case.
const REJECTED_BASES = [
  "postgres://u@h:5432/db?port=x",
  "postgres://u@h:5432/db?port=70000",
  "postgres://u@h:5432/db?port=1,2",
  "postgres://u@h:5432/db?host=a,b",
  "postgres://u@h:5432/db?host=,",
  "postgres://u@a,b:5432/db?sslmode=require",
  "postgres://u@h:5432/db?x=a b",
  "postgres://u@h:5432/db?x=%zz",
  "postgres://u@h:99999/db?sslmode=require",
  "postgres://u@[::1/db?sslmode=require",
];

function rejectionMessage(input: string): string {
  try {
    parseConnection(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectionError);
    return (err as Error).message;
  }
  throw new Error(`expected a rejection for ${input}`);
}

describe("pass= is a password in the messages of parseConnection's rejections", () => {
  test("the committed reproduction: ?port=x&pass=SECRET and its percent-encoded spellings", () => {
    for (const q of ["pass=SECRET", "%70ass=SECRET", "pass%77ord=SECRET", "password=SECRET"]) {
      const msg = rejectionMessage(`postgres://u@h:5432/db?port=x&${q}`);
      expect(msg).not.toContain("SECRET");
      expect(msg).toBe(
        `unsupported connection: postgres://u@h:5432/db?port=x&${q.replace("SECRET", "***")} (use a postgres:// URL, a SQLite file path, or "demo")`,
      );
    }
  });

  test("every rejection, with the password in the authority, in password= and in pass= (each spelling)", () => {
    let checked = 0;
    for (const base of REJECTED_BASES) {
      for (const s of SECRET_SPELLINGS("SECRET")) {
        const withAuthority = s.put(base);
        const input = s.query ? `${withAuthority}&${s.query}` : withAuthority;
        const msg = rejectionMessage(input);
        expect(msg).not.toContain("SECRET");
        expect(msg.startsWith("unsupported connection: ")).toBe(true);
        checked++;
      }
    }
    // Ambiguous unencoded credentials (an @ with no user) is a rejection too.
    for (const q of ["password=SECRET", "pass=SECRET", "%70ass=SECRET", "pass%77ord=SECRET"]) {
      const msg = rejectionMessage(`postgres://@h/db?${q}`);
      expect(msg).not.toContain("SECRET");
      checked++;
    }
    expect(checked).toBe(REJECTED_BASES.length * SECRET_SPELLINGS("x").length + 4);
  });

  test("property: 100,000 seeded random URLs with the secret in each position and encoding never show it", () => {
    let s = 0x2b5ec2e7;
    const rand = (max: number) => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % max;
    };
    const SECRET = "Zq7Secr3tWx";
    const pct = (text: string) => [...text].map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).join("");
    const halfPct = (text: string) => [...text].map((c, i) => (i % 2 ? `%${c.charCodeAt(0).toString(16)}` : c)).join("");
    const valueForms = [SECRET, pct(SECRET), halfPct(SECRET)];
    const keyForms = [
      "password", "pass", "PASS", "Password", "%70ass", "pass%77ord", "%70%61%73%73", "p%61ss", "%50ASSWORD",
    ];
    const otherParams = [
      "port=x", "port=70000", "port=54329", "port=", "host=a,b", "host=", "host=127.0.0.1", "sslmode=require",
      "x=%zz", "user=other", "db=d", "database=", "bypass=1", "compass=north", "application_name=a+b",
    ];
    const hosts = ["h", "h:5432", "127.0.0.1:54329", "a,b", "h:99999", "[::1]:5432"];

    let rejected = 0;
    for (let i = 0; i < 100_000; i++) {
      const value = valueForms[rand(valueForms.length)]!;
      const inAuthority = rand(3) === 0;
      const params: string[] = [];
      const n = rand(4);
      for (let j = 0; j < n; j++) params.push(otherParams[rand(otherParams.length)]!);
      if (!inAuthority) {
        params.splice(rand(params.length + 1), 0, `${keyForms[rand(keyForms.length)]!}=${value}`);
      }
      const userinfo = inAuthority ? `u:${value}@` : "u@";
      const scheme = rand(2) ? "postgres" : "postgresql";
      const url = `${scheme}://${userinfo}${hosts[rand(hosts.length)]!}/db${params.length ? `?${params.join("&")}` : ""}`;

      const shown: string[] = [redactConnectionInput(url), redactConnectionText(`failed: ${url} (x)`)];
      try {
        const c = parseConnection(url);
        shown.push(c.display, c.name, c.id);
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        shown.push((err as Error).message);
        rejected++;
      }
      for (const text of shown) {
        if (text.includes(SECRET) || text.includes(value)) {
          throw new Error(`secret shown for ${JSON.stringify(url)}: ${JSON.stringify(text)}`);
        }
      }
    }
    expect(rejected).toBeGreaterThan(10_000);
  });
});

describe("an empty query value is an absent one", () => {
  test("?port=, ?host= and ?host=&port=54329 use the authority's target", () => {
    const cases = [
      ["postgres://losql@127.0.0.1:54329/postgres?port=", "postgres://losql@127.0.0.1:54329/postgres"],
      ["postgres://losql@127.0.0.1:54329/postgres?host=", "postgres://losql@127.0.0.1:54329/postgres"],
      ["postgres://losql@127.0.0.1:5555/postgres?host=&port=54329", "postgres://losql@127.0.0.1:54329/postgres"],
      ["postgres://losql@127.0.0.1:54329/postgres?hostname=&port=", "postgres://losql@127.0.0.1:54329/postgres"],
      [
        "postgres://losql@127.0.0.1:54329/postgres?user=&username=&database=&db=&password=&pass=",
        "postgres://losql@127.0.0.1:54329/postgres",
      ],
      ["postgres://losql@127.0.0.1:54329/postgres?host=&hostname=other.example", "postgres://losql@other.example:5432/postgres"],
    ] as const;
    for (const [url, display] of cases) {
      const c = parseConnection(url);
      expect(c.display).toBe(display);
    }
    expect(parseConnection("postgres://losql@127.0.0.1:54329/postgres?host=").id).toBe(
      "postgres-losql-127-0-0-1-54329-postgres",
    );
  });
});
