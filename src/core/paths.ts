import { join } from "node:path";

export interface Paths {
  configDir: string;
  configFile: string;
  themesDir: string;
  stateDir: string;
  stateFile: string;
  historyFile: string;
  buffersDir: string;
}

export function resolvePaths(env: Record<string, string | undefined>, home: string): Paths {
  const configDir =
    env.LOSQL_CONFIG_DIR ||
    (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "losql") : join(home, ".config", "losql"));
  const stateDir =
    env.LOSQL_STATE_DIR ||
    (env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "losql") : join(home, ".local", "state", "losql"));

  return {
    configDir,
    configFile: join(configDir, "config.json"),
    themesDir: join(configDir, "themes"),
    stateDir,
    stateFile: join(stateDir, "state.json"),
    historyFile: join(stateDir, "history.jsonl"),
    buffersDir: join(stateDir, "buffers"),
  };
}
