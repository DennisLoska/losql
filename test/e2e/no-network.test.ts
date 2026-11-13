import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import { ROOT } from "./helpers";

// Acceptance criterion 12: losql opens no port and makes no network request of its own.
// The only network client in the tree is the Postgres driver, which talks to the database the user names:
// `src/core/db/postgres.ts` imports the `postgres` package, which no pattern below names.

/**
 * Network modules of Node and Bun and their sub-paths (`node:dns/promises`), however they are
 * imported (`from`, `import()`, `require()`, a bare `import`).
 */
const NETWORK_MODULE = /\b(?:from|import|require)\s*\(?\s*(["'`])(?:node:)?(?:http|https|http2|net|tls|dns|dgram)(?:\/[\w/]*)?\1/;

/** The members of `Bun` that open a port, connect or look a name up. */
const BUN_NETWORK = "(?:serve|listen|connect|udpSocket|dns)";

const FORBIDDEN: readonly RegExp[] = [
  NETWORK_MODULE,
  // `fetch` as an identifier (a call, a reference, `globalThis.fetch`), not the SQL keyword in a string.
  /(?<![\w$"'`])fetch(?![\w$"'`])/,
  // `globalThis["fetch"](…)`: `fetch` in quotes as the index of something.
  /[\w$)\]]\s*\[\s*(["'`])fetch\1\s*\]/,
  // `Bun.connect(…)`, `Bun.dns.lookup(…)`, `Bun["connect"](…)`.
  new RegExp(`\\bBun\\s*\\.\\s*${BUN_NETWORK}\\b`),
  new RegExp(`\\bBun\\s*\\[\\s*(["'\`])${BUN_NETWORK}\\1\\s*\\]`),
  // `import { serve } from "bun"`, `const { connect } = Bun`, `const { listen } = require("bun")`.
  new RegExp(`\\bimport\\s*(?:type\\s+)?\\{[^}]*\\b${BUN_NETWORK}\\b[^}]*\\}\\s*from\\s*(["'\`])bun\\1`),
  new RegExp(`\\{[^}]*\\b${BUN_NETWORK}\\b[^}]*\\}\\s*=\\s*(?:Bun\\b|require\\s*\\(\\s*(["'\`])bun\\1)`),
  /\bcreateServer\b/,
  /\b(?:WebSocket|EventSource|XMLHttpRequest)\b/,
  // A Worker loaded from the network.
  /\bnew\s+Worker\s*\(\s*(?:new\s+URL\s*\(\s*)?["'`](?:https?|wss?):/,
  // A spawned network client: `["curl", …]`, `"wget -q …"`, `` $`curl …` ``, "/usr/bin/curl".
  /(["'`])(?:[^"'`\s]*\/)?(?:curl|wget)(?:\1|\s)/,
];

/** The patterns that `text` matches; empty when it opens no port and makes no network request. */
function networkUses(text: string): RegExp[] {
  return FORBIDDEN.filter((pattern) => pattern.test(text));
}

describe("the detection", () => {
  const caught = [
    `await import("node:http")`,
    `const http = await import('node:https');`,
    `import { request } from 'node:http';`,
    `import http from "http";`,
    `import { connect } from "net";`,
    `import * as tls from "node:tls";`,
    `import { connect } from "node:http2";`,
    `import dns from "node:dns";`,
    `import { createSocket } from "node:dgram";`,
    `const net = require("net");`,
    `import "node:net";`,
    `await Bun.connect({ hostname: "x", port: 1, socket: {} });`,
    `Bun.listen({ hostname: "0.0.0.0", port: 1, socket: {} });`,
    `await Bun.udpSocket({});`,
    `Bun.serve({ fetch() { return new Response(); } });`,
    `http.createServer(() => {});`,
    `const w = new Worker("https://example.com/w.js");`,
    `new Worker(new URL("https://example.com/w.js"));`,
    `const f = fetch; f("https://example.com");`,
    `await fetch ("x");`,
    `await fetch("https://example.com");`,
    `globalThis.fetch(url);`,
    `const ws = new WebSocket("wss://example.com");`,
    `new EventSource("/events");`,
    `const xhr = new XMLHttpRequest();`,
    `Bun.spawn(["curl", "-s", url]);`,
    `Bun.spawn(['/usr/bin/curl', url]);`,
    "await $`curl -s ${url}`;",
    `Bun.spawnSync(["wget", "-q", url]);`,
    `exec("wget -O - " + url);`,
    `import { lookup } from "node:dns/promises";`,
    `const { resolve4 } = require("dns/promises");`,
    `await import('node:dns/promises')`,
    `import { serve } from "bun";\nserve(options);`,
    `import { listen, Glob } from 'bun';`,
    `const { connect } = Bun;`,
    `const { udpSocket: open } = Bun;`,
    `Bun["connect"]({ hostname: "x", port: 1, socket: {} });`,
    `Bun['serve'](options);`,
    `await Bun.dns.lookup("example.com");`,
    `globalThis["fetch"](url);`,
    `globalThis['fetch'](url);`,
  ];
  const notCaught = [
    `import postgres from "postgres";`,
    `const sql = postgres(url, { max: 1 });`,
    `import { spawn } from "node:child_process";`,
    `import { readFile } from "node:fs/promises";`,
    `import { join } from "node:path";`,
    `  "fetch",`,
    `const words = ['fetch', 'first'];`,
    `const rows = await cursor.prefetch();`,
    `const fetched = rows.length;`,
    `const url = new URL(text);`,
    `if (url.protocol === "https:") return;`,
    `new Worker(new URL("./worker.ts", import.meta.url));`,
    `const curly = "{";`,
    `const name = "netlify";`,
  ];

  test.each(caught)("catches %s", (line) => {
    expect(networkUses(line).length).toBeGreaterThan(0);
  });

  test.each(notCaught)("lets %s pass", (line) => {
    expect(networkUses(line)).toEqual([]);
  });
});

test("no source file opens a port or calls out to the network", async () => {
  const offenders: string[] = [];
  let scanned = 0;
  for await (const path of new Glob("src/**/*.{ts,tsx}").scan({ cwd: ROOT })) {
    if (path.includes(".test.")) continue;
    scanned++;
    const text = await Bun.file(join(ROOT, path)).text();
    for (const pattern of networkUses(text)) offenders.push(`${path}: ${pattern}`);
  }
  expect(scanned).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});

test("the old server is gone", async () => {
  expect(await Bun.file(join(ROOT, "src/server/app.ts")).exists()).toBe(false);
});
