import type { Exec } from "./exec";

const CLIPBOARD_TOOLS: readonly { bin: string; args: readonly string[] }[] = [
  { bin: "wl-copy", args: [] },
  { bin: "xclip", args: ["-selection", "clipboard"] },
  { bin: "pbcopy", args: [] },
];

const CLIPBOARD_TIMEOUT_MS = 2000;

export const MAX_OSC52_BASE64 = 100000;

export function osc52(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${encoded}\x07`;
}

/** The outcome of a copy: whether the value reached a clipboard, and if not, why. */
export type CopyResult = { ok: true } | { ok: false; reason: string };

const MAX_REASON_LENGTH = 200;

/**
 * The first non-empty line of a tool's error, or "" when it has none or when
 * it contains the copied value (a reason never repeats what was copied).
 */
function errorLine(error: string, text: string): string {
  const line = error.split(/\r?\n|\r/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return text.length > 0 && line.includes(text) ? "" : line;
}

function bounded(reason: string): string {
  return reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

/**
 * Writes the terminal clipboard sequence (OSC 52) when the value fits in it,
 * and hands the value to the first clipboard tool that accepts it. Resolves to
 * `{ ok: true }` when at least one of the two happened, otherwise to
 * `{ ok: false, reason }` with a short reason for the user. Never throws.
 */
export async function copyToClipboard(
  text: string,
  deps: {
    write: (data: string) => void;
    which: (bin: string) => string | null;
    exec: Exec;
  },
): Promise<CopyResult> {
  // The length of the value in base64, padding included.
  const encodedLength = Math.ceil(Buffer.from(text, "utf8").length / 3) * 4;
  const fitsSequence = encodedLength <= MAX_OSC52_BASE64;
  let wroteSequence = false;
  if (fitsSequence) {
    try {
      deps.write(osc52(text));
      wroteSequence = true;
    } catch {
      // The terminal did not accept it; a clipboard tool may still.
    }
  }

  // Why the tool tried last did not take the value; null while none was tried.
  let toolFailure: string | null = null;
  for (const tool of CLIPBOARD_TOOLS) {
    let resolved: string | null = null;
    try {
      resolved = deps.which(tool.bin);
    } catch {
      continue;
    }
    if (resolved === null) continue;
    try {
      const res = await deps.exec({
        cmd: [resolved, ...tool.args],
        stdin: text,
        timeoutMs: CLIPBOARD_TIMEOUT_MS,
        discardOutput: true,
      });
      if (res.code === 0 && !res.timedOut) {
        return { ok: true };
      }
      if (res.timedOut) {
        toolFailure = `${tool.bin} timed out`;
      } else {
        const detail = errorLine(res.stderr ?? "", text) || `exit code ${res.code ?? "unknown"}`;
        toolFailure = `${tool.bin} failed: ${detail}`;
      }
    } catch (err) {
      const detail = errorLine(err instanceof Error ? err.message : String(err), text);
      toolFailure = detail ? `${tool.bin} failed: ${detail}` : `${tool.bin} failed`;
    }
  }

  if (wroteSequence) return { ok: true };
  if (toolFailure !== null) return { ok: false, reason: bounded(toolFailure) };
  return {
    ok: false,
    reason: fitsSequence
      ? "the terminal did not accept it and no clipboard tool was found"
      : "the value is too large for the terminal clipboard and no clipboard tool was found",
  };
}
