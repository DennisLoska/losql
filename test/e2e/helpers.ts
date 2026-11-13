import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");

/**
 * The environment a test gives losql: the test process's own without its PATH, DATABASE_URL, PG*
 * and LOSQL_* variables (a test sets what it needs in `set`), so that losql finds no Provider CLI
 * of the machine and no database or setting of the developer. `set` must hold a PATH: a directory
 * of the test that is empty or holds only the stubs the test installed.
 */
export function isolatedEnv(set: Record<string, string> & { PATH: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name === "PATH" || name === "DATABASE_URL" || name.startsWith("PG") || name.startsWith("LOSQL_")) continue;
    env[name] = value;
  }
  return { ...env, ...set };
}

/**
 * Runs losql from source. Without a PATH in `options.env` it gets an empty directory as its PATH,
 * and without LOSQL_CONFIG_DIR and LOSQL_STATE_DIR directories of its own (see `isolatedEnv`).
 */
export async function losql(
  args: string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const own = await mkdtemp(join(tmpdir(), "losql-run-"));
  try {
    await mkdir(join(own, "bin"));
    const env = isolatedEnv({
      PATH: join(own, "bin"),
      LOSQL_CONFIG_DIR: join(own, "config"),
      LOSQL_STATE_DIR: join(own, "state"),
      ...options.env,
    });
    const proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/main.ts"), ...args], {
      cwd: ROOT,
      env,
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    await rm(own, { recursive: true, force: true });
  }
}

/**
 * Installs into `binDir` one script for each name a Provider CLI is looked for under; each appends a
 * line to `logFile` when started. A test puts `binDir` first on a PATH to see that nothing starts them.
 */
export async function installLoggingProviderClis(binDir: string, logFile: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  for (const name of ["claude", "codex", "opencode", "antigravity", "agy"]) {
    const path = join(binDir, name);
    await writeFile(path, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(logFile)}\necho 0.0.1\n`);
    await chmod(path, 0o755);
  }
}
