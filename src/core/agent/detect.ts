import { PROVIDER_IDS, type ProviderId } from "../config";
import type { Exec } from "../exec";
import { PROVIDERS } from "./providers";
import type { ProviderAdapter } from "./providers/types";
import { type ConnectionEnvSource, sanitizeEnv } from "./run";

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  installHint: string;
}

const VERSION_TIMEOUT_MS = 5000;
const MODELS_TIMEOUT_MS = 15000;
const VERSION_REGEX = /\d+\.\d+(?:\.\d+)?/;

export async function detectProviders(deps: {
  which: (bin: string) => string | null;
  exec: Exec;
  env?: Record<string, string | undefined>;
  /** The saved Connections: the variables they read as `${NAME}` are not handed to the version call. */
  connections?: readonly ConnectionEnvSource[];
}): Promise<ProviderStatus[]> {
  // A Provider CLI asked for its version gets the same reduced environment as a turn.
  const env = sanitizeEnv(deps.env ?? process.env, deps.connections);
  return Promise.all(
    PROVIDER_IDS.map(async (id): Promise<ProviderStatus> => {
      const adapter = PROVIDERS[id];
      let path: string | null = null;
      for (const bin of adapter.binaries) {
        const found = deps.which(bin);
        if (found) {
          path = found;
          break;
        }
      }

      if (!path) {
        return {
          id: adapter.id,
          label: adapter.label,
          installed: false,
          path: null,
          version: null,
          installHint: adapter.installHint,
        };
      }

      let version: string | null = null;
      try {
        const res = await deps.exec({
          cmd: [path, "--version"],
          env,
          timeoutMs: VERSION_TIMEOUT_MS,
        });
        if (res.code === 0 && !res.timedOut && !res.aborted) {
          const match = VERSION_REGEX.exec(res.stdout);
          if (match) {
            version = match[0];
          }
        }
      } catch {
        version = null;
      }

      return {
        id: adapter.id,
        label: adapter.label,
        installed: true,
        path,
        version,
        installHint: adapter.installHint,
      };
    }),
  );
}

export async function listModels(
  adapter: ProviderAdapter,
  binPath: string,
  exec: Exec,
  env: Record<string, string | undefined> = process.env,
  connections: readonly ConnectionEnvSource[] = [],
): Promise<string[]> {
  const base = [...adapter.staticModels];
  if (!adapter.modelsArgs || !adapter.parseModels) {
    return base;
  }

  try {
    const res = await exec({
      cmd: [binPath, ...adapter.modelsArgs],
      // A Provider CLI asked for its models gets the same reduced environment as a turn.
      env: sanitizeEnv(env, connections),
      timeoutMs: MODELS_TIMEOUT_MS,
    });
    if (res.code !== 0 || res.timedOut || res.aborted) {
      return base;
    }
    const dynamic = adapter.parseModels(res.stdout);
    const seen = new Set<string>(base);
    for (const model of dynamic) {
      if (!seen.has(model)) {
        seen.add(model);
        base.push(model);
      }
    }
    return base;
  } catch {
    return base;
  }
}
