export type ParsedArgs =
  | { kind: "tui"; connection?: string; theme?: string; transparent?: boolean; animations?: boolean }
  | { kind: "exec"; connection?: string; format: "table" | "json" | "csv"; maxRows?: number; readOnly: boolean; sql: string }
  | { kind: "ask"; connection?: string; provider?: string; model?: string; run: boolean; question: string }
  | { kind: "providers"; json: boolean; test: boolean }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const USAGE = [
  'losql [connection]                 start the TUI (connection: saved name, URL, file path, or "demo")',
  "  --theme <name>  --transparent / --no-transparent  --no-animations",
  "losql exec [-c <connection>] [--format table|json|csv] [--max-rows <n>] [--read-only] <sql | ->",
  "losql ask  [-c <connection>] [--provider <id>] [--model <m>] [--run] <question>",
  "losql providers [--json] [--test]",
  "losql --help | --version",
].join("\n");

export function parseArgs(argv: string[]): ParsedArgs {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--version" || arg === "-v") return { kind: "version" };
  }

  const first = argv[0];
  if (first === "exec") return parseExec(argv.slice(1));
  if (first === "ask") return parseAsk(argv.slice(1));
  if (first === "providers") return parseProviders(argv.slice(1));
  return parseTui(argv);
}

function takeOptionValue(argv: string[], index: number): string | undefined {
  const val = argv[index + 1];
  if (val === undefined || val.startsWith("-")) return undefined;
  return val;
}

function isOptionLike(arg: string): boolean {
  return arg.startsWith("-") && !/[ \t\n]/.test(arg);
}

function parseTui(argv: string[]): ParsedArgs {
  const result: {
    kind: "tui";
    connection?: string;
    theme?: string;
    transparent?: boolean;
    animations?: boolean;
  } = { kind: "tui" };
  let optionsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg === "--theme") {
      const val = takeOptionValue(argv, i);
      if (val === undefined) return { kind: "error", message: "--theme needs a value" };
      i++;
      result.theme = val;
    } else if (!optionsEnded && arg === "--transparent") {
      result.transparent = true;
    } else if (!optionsEnded && arg === "--no-transparent") {
      result.transparent = false;
    } else if (!optionsEnded && arg === "--no-animations") {
      result.animations = false;
    } else if (!optionsEnded && arg.startsWith("-")) {
      return { kind: "error", message: `unknown option ${arg}` };
    } else {
      if (result.connection !== undefined) {
        return { kind: "error", message: `unexpected argument ${arg}` };
      }
      result.connection = arg;
    }
  }

  return result;
}

function parseExec(argv: string[]): ParsedArgs {
  const result: {
    kind: "exec";
    connection?: string;
    format: "table" | "json" | "csv";
    maxRows?: number;
    readOnly: boolean;
    sql: string;
  } = { kind: "exec", format: "table", readOnly: false, sql: "" };
  const positionals: string[] = [];
  let optionsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg === "-c") {
      const val = takeOptionValue(argv, i);
      if (val === undefined) return { kind: "error", message: "exec: -c needs a value" };
      i++;
      result.connection = val;
    } else if (!optionsEnded && arg === "--format") {
      const val = takeOptionValue(argv, i);
      if (val === undefined) return { kind: "error", message: "exec: --format needs a value" };
      i++;
      if (val !== "table" && val !== "json" && val !== "csv") {
        return { kind: "error", message: "exec: --format must be table, json or csv" };
      }
      result.format = val;
    } else if (!optionsEnded && arg === "--max-rows") {
      const val = takeOptionValue(argv, i);
      if (val === undefined) return { kind: "error", message: "exec: --max-rows needs a value" };
      i++;
      const num = Number(val);
      if (!/^[1-9]\d*$/.test(val) || !Number.isSafeInteger(num)) {
        return { kind: "error", message: "exec: --max-rows must be a positive integer" };
      }
      result.maxRows = num;
    } else if (!optionsEnded && arg === "--read-only") {
      result.readOnly = true;
    } else if (!optionsEnded && arg !== "-" && isOptionLike(arg)) {
      return { kind: "error", message: `unknown option ${arg}` };
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    return { kind: "error", message: "exec: missing SQL (pass a statement or - for stdin)" };
  }
  if (positionals.length > 1 && positionals.includes("-")) {
    return { kind: "error", message: "exec: - (stdin) cannot be combined with a statement" };
  }

  result.sql = positionals.join(" ");
  return result;
}

function parseAsk(argv: string[]): ParsedArgs {
  const result: {
    kind: "ask";
    connection?: string;
    provider?: string;
    model?: string;
    run: boolean;
    question: string;
  } = { kind: "ask", run: false, question: "" };
  const positionals: string[] = [];
  let optionsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg === "-c") {
      const val = takeOptionValue(argv, i);
      if (val === undefined) return { kind: "error", message: "ask: -c needs a value" };
      i++;
      result.connection = val;
    } else if (!optionsEnded && arg === "--provider") {
      const val = takeOptionValue(argv, i);
      if (val === undefined) return { kind: "error", message: "ask: --provider needs a value" };
      i++;
      result.provider = val;
    } else if (!optionsEnded && arg === "--model") {
      const val = takeOptionValue(argv, i);
      if (val === undefined) return { kind: "error", message: "ask: --model needs a value" };
      i++;
      result.model = val;
    } else if (!optionsEnded && arg === "--run") {
      result.run = true;
    } else if (!optionsEnded && isOptionLike(arg)) {
      return { kind: "error", message: `unknown option ${arg}` };
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    return { kind: "error", message: "ask: missing question" };
  }

  result.question = positionals.join(" ");
  return result;
}

function parseProviders(argv: string[]): ParsedArgs {
  let json = false;
  let test = false;
  let optionsEnded = false;

  for (const arg of argv) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg === "--json") {
      json = true;
    } else if (!optionsEnded && arg === "--test") {
      test = true;
    } else if (!optionsEnded && arg.startsWith("-")) {
      return { kind: "error", message: `unknown option ${arg}` };
    } else {
      return { kind: "error", message: `unexpected argument ${arg}` };
    }
  }

  return { kind: "providers", json, test };
}

