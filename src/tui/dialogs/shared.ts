import { PROVIDERS } from "../../core/agent/providers";
import type { ProviderId } from "../../core/config";
import type { AppApi } from "../app";

type QuitCancel = () => void | Promise<void>;

const quitListeners = new WeakMap<AppApi, Set<QuitCancel>>();

/**
 * Runs `cancel` when the application quits, until the returned function is called.
 * One quit hook per application serves every dialog; the cancels run together.
 */
export function registerQuitCancel(api: AppApi, cancel: QuitCancel): () => void {
  let set = quitListeners.get(api);
  if (!set) {
    const created = new Set<QuitCancel>();
    set = created;
    quitListeners.set(api, created);
    api.onQuit(async () => {
      await Promise.allSettled([...created].map(async (fn) => fn()));
    });
  }
  const listeners = set;
  listeners.add(cancel);
  return () => {
    listeners.delete(cancel);
  };
}

/** How many quit cancels are registered for this application: what an open dialog left behind. */
export function quitCancelCount(api: AppApi): number {
  return quitListeners.get(api)?.size ?? 0;
}

export const MAX_MODEL_NAME_LENGTH = 200;

const FORMAT_CHARACTER_RE = /\p{Cf}/u;

/**
 * A Model name is passed to the Provider's CLI as one argument: no whitespace, no control or
 * format (Unicode category Cf, such as bidirectional marks) characters, no leading `-`, and at
 * most 200 characters.
 */
export function isValidModelName(name: string): boolean {
  if (name.length > MAX_MODEL_NAME_LENGTH * 2) return false;
  if ([...name].length > MAX_MODEL_NAME_LENGTH) return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (name.startsWith("-")) return false;
  if (/\s/.test(name)) return false;
  if (/[\x00-\x1f\x7f-\x9f]/.test(name)) return false;
  if (FORMAT_CHARACTER_RE.test(name)) return false;
  return true;
}

export function resolveProviderPath(api: AppApi, id: ProviderId): string | null {
  const detected = api.agent.providers().find((p) => p.id === id);
  if (detected?.path) return detected.path;
  const adapter = PROVIDERS[id];
  for (const bin of adapter.binaries) {
    const found = api.deps.which(bin);
    if (found) return found;
  }
  return null;
}

const providerSaveFailures = new WeakSet<AppApi>();

/** Recorded by the Providers dialog when it resolved `null` because its choice could not be saved. */
export function markProviderSaveFailed(api: AppApi): void {
  providerSaveFailures.add(api);
}

/** Whether the last Providers dialog ended in a failed save; clears the mark. */
export function takeProviderSaveFailed(api: AppApi): boolean {
  return providerSaveFailures.delete(api);
}
