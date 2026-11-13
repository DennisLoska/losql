import { readdir } from "node:fs/promises";
import { createMemo, createSignal, type JSX, onMount } from "solid-js";
import type { SavedConnection } from "../../core/config";
import { parseConnection } from "../../core/db/connection";
import { redactConnectionInput, redactConnectionText } from "../../core/db/redact";
import type { AppApi } from "../app";
import { printable } from "../ui/printable";
import { DialogSelect, type SelectOption } from "../ui/select";

export interface ConnectionChoice {
  kind: "saved" | "env" | "file" | "enter" | "demo";
  title: string;
  description: string;
  category: "Saved" | "Detected" | "Other";
  target: string | null;
}

const CONNECTIONS_DIALOG_WIDTH = 64;

const SQLITE_EXTENSIONS = [".db", ".sqlite", ".sqlite3", ".db3"];

const CONTROL_OR_NEWLINE_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

const MAX_NAME_CHARACTERS = 64;

/** `editing` is the entry being renamed: keeping its own name exactly as stored is always allowed. */
function validateConnectionName(
  raw: string,
  connections: SavedConnection[],
  editing?: SavedConnection,
): string | null {
  if (CONTROL_OR_NEWLINE_RE.test(raw)) {
    return "A name cannot contain control characters";
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Characters are code points: an emoji is one character, not two UTF-16 units.
  if (trimmed.length > MAX_NAME_CHARACTERS && [...trimmed].length > MAX_NAME_CHARACTERS) {
    return `A name can have at most ${MAX_NAME_CHARACTERS} characters`;
  }
  // The name is saved trimmed. Saving exactly the stored name changes nothing; any other name is
  // checked against every other entry, so hand-written entries "a" and " a" never both become "a".
  if (editing !== undefined && editing.name === trimmed) return null;
  if (connections.some((c) => c !== editing && c.name.trim() === trimmed)) {
    return `A connection named "${trimmed}" already exists`;
  }
  return null;
}

export function displayUrl(url: string): string {
  const sanitized = url.replace(
    /((?::\/\/[^/@\s]*:|(?:^|[?&\s;])password\s*=\s*))\$\{[A-Za-z_][A-Za-z0-9_]*\}/gi,
    "$1x",
  );
  try {
    return parseConnection(sanitized, { exists: () => false }).display;
  } catch {
    return redactConnectionInput(url);
  }
}

export async function findSqliteFiles(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (SQLITE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        names.push(entry.name);
      }
    }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return names.slice(0, 20);
  } catch {
    return [];
  }
}

export function connectionChoices(input: {
  saved: SavedConnection[];
  env: Record<string, string | undefined>;
  files: string[];
}): ConnectionChoice[] {
  const choices: ConnectionChoice[] = [];

  for (const s of input.saved) {
    choices.push({
      kind: "saved",
      title: printable(redactConnectionText(s.name)),
      description: displayUrl(s.url),
      category: "Saved",
      target: s.name,
    });
  }

  const dbUrl = input.env.DATABASE_URL?.trim();
  if (dbUrl && dbUrl.length > 0) {
    choices.push({
      kind: "env",
      title: "DATABASE_URL",
      description: displayUrl(dbUrl),
      category: "Detected",
      target: dbUrl,
    });
  }

  for (const file of input.files) {
    choices.push({
      kind: "file",
      title: file,
      description: "SQLite file",
      category: "Detected",
      target: file,
    });
  }

  choices.push({
    kind: "enter",
    title: "Enter a URL or file path",
    description: "postgres://… or a SQLite file",
    category: "Other",
    target: null,
  });

  choices.push({
    kind: "demo",
    title: "Explore the demo database",
    description: "A small sample store, in memory",
    category: "Other",
    target: "demo",
  });

  return choices;
}

/**
 * A row of the dialog. A saved row stands for one entry of the configuration, by identity, so
 * that two saved Connections with the same name (possible in a hand-written file) stay two.
 */
interface ConnectionRow {
  choice: ConnectionChoice;
  entry: SavedConnection | null;
}

function ConnectionsDialog(props: {
  api: AppApi;
  step?: string;
  close: () => void;
  onConnected: () => void;
}): JSX.Element {
  const [files, setFiles] = createSignal<string[]>([]);
  const [notice, setNotice] = createSignal<{ text: string; kind: "info" | "error" } | null>(null);
  let busy = false;

  onMount(() => {
    void findSqliteFiles(props.api.deps.cwd).then((found) => {
      setFiles(found);
    });
  });

  const rows = createMemo<ConnectionRow[]>(() => {
    const saved = props.api.config.config().connections;
    const choices = connectionChoices({ saved, env: props.api.deps.env, files: files() });
    // connectionChoices lists the saved entries first, in the order of the configuration.
    return choices.map((choice, i) => ({
      choice,
      entry: choice.kind === "saved" ? (saved[i] ?? null) : null,
    }));
  });

  const options = createMemo<SelectOption<ConnectionRow>[]>(() =>
    rows().map((row) => ({
      title: row.choice.title,
      description: row.choice.description,
      category: row.choice.category,
      value: row,
    })),
  );

  const currentChoice = createMemo<ConnectionRow | undefined>(() => {
    const connName = props.api.session.connection()?.name;
    if (!connName) return undefined;
    return rows().find(
      ({ choice: c }) =>
        c.target !== null &&
        (c.target === connName || redactConnectionInput(c.target) === connName),
    );
  });

  /**
   * What to connect to for a row. A saved entry is reached by its name when it is the first entry
   * of that name (so the Connection keeps its name, as `:connect <name>` and the remembered last
   * Connection resolve a name to the first entry); a later entry with a taken name by its URL.
   */
  const connectTarget = (row: ConnectionRow): string | null => {
    const { choice, entry } = row;
    if (entry === null) return choice.target;
    const first = props.api.config.config().connections.find((c) => c.name === entry.name);
    return first === entry ? entry.name : entry.url;
  };

  const savedEntry = (row: ConnectionRow): SavedConnection | null => {
    if (row.choice.kind !== "saved" || row.entry === null) return null;
    return props.api.config.config().connections.includes(row.entry) ? row.entry : null;
  };

  const title = () =>
    props.step ? `${props.step} · Connect a database` : "Connections";

  const handleSelect = async (option: SelectOption<ConnectionRow>) => {
    if (busy) return;
    const choice = option.value.choice;
    const target = connectTarget(option.value);

    if (target !== null) {
      busy = true;
      setNotice({ text: `Connecting to ${choice.title}…`, kind: "info" });
      try {
        const res = await props.api.session.connect(target);
        if (res.ok) {
          props.onConnected();
          props.close();
        } else {
          setNotice({ text: printable(res.message), kind: "error" });
        }
      } finally {
        busy = false;
      }
      return;
    }

    // choice.kind === "enter"
    busy = true;
    try {
      const value = await props.api.dialog.prompt({
        title: "URL or file path",
        placeholder: "postgres://user@host/db or ./file.db",
        validate: async (val) => {
          const res = await props.api.session.connect(val);
          return res.ok ? null : res.message;
        },
      });
      if (value === null) {
        return;
      }

      const saveName = await props.api.dialog.prompt({
        title: "Save this connection?",
        description: "Give it a name to save it. Leave empty to skip.",
        validate: (val) =>
          validateConnectionName(val, props.api.config.config().connections),
      });
      const trimmedName = saveName?.trim() ?? "";
      if (trimmedName.length > 0) {
        const trimmedUrl = value.trim();
        const prevConnections = props.api.config.config().connections;
        try {
          await props.api.config.set((cfg) => ({
            ...cfg,
            connections: [...cfg.connections, { name: trimmedName, url: trimmedUrl }],
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await props.api.config
            .set((cfg) => ({ ...cfg, connections: prevConnections }))
            .catch(() => {});
          props.api.toast.show({
            message: printable(`Could not save config: ${msg}`),
            kind: "error",
          });
        }
      }

      props.onConnected();
      props.close();
    } finally {
      busy = false;
    }
  };

  const handleEdit = async (option: SelectOption<ConnectionRow>) => {
    if (busy) return;
    const currentSaved = savedEntry(option.value);
    if (!currentSaved) return;

    busy = true;
    try {
      const nextName = await props.api.dialog.prompt({
        title: "Name",
        initial: currentSaved.name,
        validate: (val) =>
          validateConnectionName(val, props.api.config.config().connections, currentSaved),
      });
      if (nextName === null) return;

      const nextUrl = await props.api.dialog.prompt({
        title: "URL or file path",
        initial: currentSaved.url,
      });
      if (nextUrl === null) return;

      const trimmedName = nextName.trim();
      const trimmedUrl = nextUrl.trim();
      if (trimmedName.length === 0 || trimmedUrl.length === 0) return;

      const prevConnections = props.api.config.config().connections;
      try {
        await props.api.config.set((cfg) => ({
          ...cfg,
          connections: cfg.connections.map((item) =>
            item === currentSaved ? { name: trimmedName, url: trimmedUrl } : item,
          ),
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await props.api.config
          .set((cfg) => ({ ...cfg, connections: prevConnections }))
          .catch(() => {});
        setNotice({ text: printable(`Could not save config: ${msg}`), kind: "error" });
      }
    } finally {
      busy = false;
    }
  };

  const handleDelete = async (option: SelectOption<ConnectionRow>) => {
    if (busy) return;
    const entry = savedEntry(option.value);
    if (!entry) return;
    const displayName = option.value.choice.title;
    busy = true;
    try {
      const confirmed = await props.api.dialog.confirm({
        title: `Delete "${displayName}"?`,
        confirm: "Delete",
        danger: true,
      });
      if (!confirmed) return;

      const prevConnections = props.api.config.config().connections;
      try {
        await props.api.config.set((cfg) => ({
          ...cfg,
          connections: cfg.connections.filter((c) => c !== entry),
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await props.api.config
          .set((cfg) => ({ ...cfg, connections: prevConnections }))
          .catch(() => {});
        setNotice({ text: printable(`Could not save config: ${msg}`), kind: "error" });
      }
    } finally {
      busy = false;
    }
  };

  return (
    <DialogSelect
      title={title()}
      panelWidth={CONNECTIONS_DIALOG_WIDTH}
      options={options()}
      current={currentChoice()}
      notice={notice()}
      actions={[
        {
          key: "<C-e>",
          label: "edit",
          run: (opt) => {
            void handleEdit(opt);
          },
        },
        {
          key: "<C-d>",
          label: "delete",
          run: (opt) => {
            void handleDelete(opt);
          },
        },
      ]}
      onSelect={(opt) => {
        void handleSelect(opt);
      }}
    />
  );
}

const activeConnections = new WeakMap<AppApi, Promise<boolean>>();

/** Resolves whether a Connection was made; while the dialog is open, returns the first call's promise. */
export function openConnections(
  api: AppApi,
  options?: { step?: string },
): Promise<boolean> {
  const existing = activeConnections.get(api);
  if (existing) return existing;

  const promise = new Promise<boolean>((resolve) => {
    let connected = false;
    let settled = false;
    api.dialog.open(
      (close) => (
        <ConnectionsDialog
          api={api}
          step={options?.step}
          close={close}
          onConnected={() => {
            connected = true;
          }}
        />
      ),
      {
        width: CONNECTIONS_DIALOG_WIDTH,
        onClose() {
          if (!settled) {
            settled = true;
            activeConnections.delete(api);
            resolve(connected);
          }
        },
      },
    );
  });
  // A dialog that failed to open rejects the promise; nothing is left open to wait for.
  promise.catch(() => {
    if (activeConnections.get(api) === promise) activeConnections.delete(api);
  });
  activeConnections.set(api, promise);
  return promise;
}
