import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Installs a fake `claude` executable into `binDir`. Each run records the prompt it was given in
 * `stubDir/prompt-<n>.txt` and answers with the next entry of `stubDir/replies.json`, in the
 * stream-json shape the real CLI prints. `binDir` also gets a `bun` link so the stub's shebang
 * resolves when PATH holds nothing else.
 */
export async function installStubClaude(binDir: string, stubDir: string, replies: string[]): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await mkdir(stubDir, { recursive: true });
  await symlink(process.execPath, join(binDir, "bun")).catch(() => {});
  await writeFile(join(stubDir, "replies.json"), JSON.stringify(replies));
  const script = `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("9.9.9 (stub)"); process.exit(0); }
const dir = ${JSON.stringify(stubDir)};
const counter = join(dir, "count");
const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(n + 1));
writeFileSync(join(dir, "prompt-" + n + ".txt"), await Bun.stdin.text());
writeFileSync(join(dir, "args-" + n + ".json"), JSON.stringify(process.argv.slice(2)));
const replies = JSON.parse(readFileSync(join(dir, "replies.json"), "utf8"));
const text = replies[Math.min(n, replies.length - 1)];
console.log(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }));
`;
  const path = join(binDir, "claude");
  await writeFile(path, script);
  await chmod(path, 0o755);
}

/** A PATH that contains only the stub directory, so none of the real provider CLIs is found. */
export function stubPath(binDir: string): string {
  return binDir;
}

/**
 * Installs a fake `claude` executable into `binDir` that answers `--version` normally,
 * and on a real invocation writes its PID to `pidFile` and sleeps for 30 seconds.
 */
export async function installSleepingStubClaude(
  binDir: string,
  pidFile: string,
  sleepMs = 30000,
): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await symlink(process.execPath, join(binDir, "bun")).catch(() => {});
  const script = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("9.9.9 (stub)"); process.exit(0); }
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
await Bun.sleep(${sleepMs});
`;
  const path = join(binDir, "claude");
  await writeFile(path, script);
  await chmod(path, 0o755);
}

