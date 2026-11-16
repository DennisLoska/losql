import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ReleaseTarget {
  readonly id: "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";
  readonly label: string;
  readonly os: "linux" | "darwin";
  readonly arch: "x64" | "arm64";
  readonly bunTarget: "bun-linux-x64" | "bun-linux-arm64" | "bun-darwin-x64" | "bun-darwin-arm64";
  readonly archive: string;
}

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  {
    id: "linux-x64",
    label: "Linux (x86_64)",
    os: "linux",
    arch: "x64",
    bunTarget: "bun-linux-x64",
    archive: "losql-linux-x64.tar.gz",
  },
  {
    id: "linux-arm64",
    label: "Linux (ARM64 / aarch64)",
    os: "linux",
    arch: "arm64",
    bunTarget: "bun-linux-arm64",
    archive: "losql-linux-arm64.tar.gz",
  },
  {
    id: "darwin-x64",
    label: "macOS (Intel x86_64)",
    os: "darwin",
    arch: "x64",
    bunTarget: "bun-darwin-x64",
    archive: "losql-darwin-x64.tar.gz",
  },
  {
    id: "darwin-arm64",
    label: "macOS (Apple Silicon ARM64)",
    os: "darwin",
    arch: "arm64",
    bunTarget: "bun-darwin-arm64",
    archive: "losql-darwin-arm64.tar.gz",
  },
] as const;

export const ARCHIVE_FILES = ["LICENSE", "NOTICE", "README.md"] as const;

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const README_BADGE_RE = /(https:\/\/img\.shields\.io\/badge\/version-)(\d+\.\d+\.\d+)(-9ece6a\?style=flat-square"\s+alt="version\s+)(\d+\.\d+\.\d+)(")/;
const LANDING_JSONLD_RE = /("softwareVersion"\s*:\s*")(\d+\.\d+\.\d+)(")/;
const LANDING_INSTALL_URL_RE = /(https:\/\/raw\.githubusercontent\.com\/DennisLoska\/losql\/v)(\d+\.\d+\.\d+)(\/install\.sh\s*\|\s*sh)/;
const LANDING_FOOTER_RE = /(Omarchy First · v)(\d+\.\d+\.\d+)(<\/p>)/;

export interface VersionSources {
  packageJson: string;
  readmeMd: string;
  landingHtml: string;
  changelogMd: string;
}

export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

export function normalizeTag(input: string): { version: string; tag: string } | null {
  const version = input.startsWith("v") ? input.slice(1) : input;
  if (!isValidSemver(version)) return null;
  return { version, tag: `v${version}` };
}

export function readPackageVersion(packageJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    throw new Error("package.json: invalid JSON");
  }
  const version = (parsed as { version?: unknown })?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json: missing string version");
  }
  return version;
}

export function extractChangelogSection(changelog: string, version: string): string | null {
  const escaped = version.replaceAll(".", "\\.");
  const headerRe = new RegExp(`^## \\[${escaped}\\](?:\\s+-\\s+\\S+.*)?$`, "m");
  const match = headerRe.exec(changelog);
  if (!match || match.index === undefined) return null;

  const afterHeader = changelog.slice(match.index + match[0].length);
  const nextHeader = /^## \[/m.exec(afterHeader);
  const body = nextHeader && nextHeader.index !== undefined
    ? afterHeader.slice(0, nextHeader.index)
    : afterHeader;
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function checkVersionSources(sources: VersionSources, expectedTagOrVersion?: string): string[] {
  const problems: string[] = [];
  let canonical: string;
  try {
    canonical = readPackageVersion(sources.packageJson);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
    return problems;
  }

  if (!isValidSemver(canonical)) {
    problems.push(`package.json: version "${canonical}" is not valid X.Y.Z semver`);
  }

  if (expectedTagOrVersion !== undefined) {
    const normalized = normalizeTag(expectedTagOrVersion);
    if (!normalized) {
      problems.push(`tag "${expectedTagOrVersion}" is invalid: expected vX.Y.Z or X.Y.Z`);
    } else if (normalized.version !== canonical) {
      problems.push(`tag "${normalized.tag}" (${normalized.version}) does not match package.json version "${canonical}"`);
    }
  }

  const badgeMatch = README_BADGE_RE.exec(sources.readmeMd);
  if (!badgeMatch) {
    problems.push("README.md: version badge not found");
  } else if (badgeMatch[2] !== canonical || badgeMatch[4] !== canonical) {
    problems.push(`README.md: version badge "${badgeMatch[2]}" / alt "${badgeMatch[4]}" does not match package.json "${canonical}"`);
  }

  const jsonLdMatch = LANDING_JSONLD_RE.exec(sources.landingHtml);
  if (!jsonLdMatch) {
    problems.push("landing/src/index.html: JSON-LD softwareVersion not found");
  } else if (jsonLdMatch[2] !== canonical) {
    problems.push(`landing/src/index.html: JSON-LD softwareVersion "${jsonLdMatch[2]}" does not match package.json "${canonical}"`);
  }

  const installUrlMatch = LANDING_INSTALL_URL_RE.exec(sources.landingHtml);
  if (!installUrlMatch) {
    problems.push("landing/src/index.html: version-pinned install.sh command not found");
  } else if (installUrlMatch[2] !== canonical) {
    problems.push(`landing/src/index.html: install.sh URL version "v${installUrlMatch[2]}" does not match package.json "${canonical}"`);
  }

  const footerMatch = LANDING_FOOTER_RE.exec(sources.landingHtml);
  if (!footerMatch) {
    problems.push("landing/src/index.html: footer version not found");
  } else if (footerMatch[2] !== canonical) {
    problems.push(`landing/src/index.html: footer version "v${footerMatch[2]}" does not match package.json "${canonical}"`);
  }

  const section = extractChangelogSection(sources.changelogMd, canonical);
  if (!section) {
    problems.push(`CHANGELOG.md: missing non-empty section "## [${canonical}]"`);
  }

  return problems;
}

export function bumpVersionSources(
  sources: Omit<VersionSources, "changelogMd">,
  nextVersion: string,
): Omit<VersionSources, "changelogMd"> {
  const normalized = normalizeTag(nextVersion);
  if (!normalized) {
    throw new Error(`Invalid version "${nextVersion}": expected X.Y.Z`);
  }
  const v = normalized.version;

  const packageJsonRe = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  if (!packageJsonRe.test(sources.packageJson)) {
    throw new Error("package.json: version field not found");
  }
  const packageJson = sources.packageJson.replace(packageJsonRe, `$1${v}$3`);

  if (!README_BADGE_RE.test(sources.readmeMd)) {
    throw new Error("README.md: version badge not found");
  }
  const readmeMd = sources.readmeMd.replace(README_BADGE_RE, `$1${v}$3${v}$5`);

  if (!LANDING_JSONLD_RE.test(sources.landingHtml)) {
    throw new Error("landing/src/index.html: JSON-LD softwareVersion not found");
  }
  if (!LANDING_INSTALL_URL_RE.test(sources.landingHtml)) {
    throw new Error("landing/src/index.html: version-pinned install.sh command not found");
  }
  if (!LANDING_FOOTER_RE.test(sources.landingHtml)) {
    throw new Error("landing/src/index.html: footer version not found");
  }
  const landingHtml = sources.landingHtml
    .replace(LANDING_JSONLD_RE, `$1${v}$3`)
    .replace(LANDING_INSTALL_URL_RE, `$1${v}$3`)
    .replace(LANDING_FOOTER_RE, `$1${v}$3`);

  return { packageJson, readmeMd, landingHtml };
}

export function formatReleaseNotes(options: {
  version: string;
  changelog: string;
  repo?: string;
}): string {
  const normalized = normalizeTag(options.version);
  if (!normalized) {
    throw new Error(`Invalid version: ${options.version}`);
  }
  const { version, tag } = normalized;
  const repo = options.repo ?? "DennisLoska/losql";
  const section = extractChangelogSection(options.changelog, version);
  if (!section) {
    throw new Error(`CHANGELOG.md has no section for [${version}]`);
  }

  const assetRows = RELEASE_TARGETS.map(
    (t) =>
      `| ${t.label} | [\`${t.archive}\`](https://github.com/${repo}/releases/download/${tag}/${t.archive}) |`,
  ).join("\n");

  return [
    section,
    "",
    "---",
    "",
    "### Installation",
    "",
    "**Install prebuilt binary (Linux & macOS):**",
    "```bash",
    `curl -fsSL https://raw.githubusercontent.com/${repo}/${tag}/install.sh | sh`,
    "```",
    "",
    "**Release archives:**",
    "",
    "| Platform | Archive |",
    "| --- | --- |",
    assetRows,
    "",
    `Verify archive integrity against [\`SHA256SUMS.txt\`](https://github.com/${repo}/releases/download/${tag}/SHA256SUMS.txt) with \`sha256sum -c SHA256SUMS.txt\` (or \`shasum -a 256 -c SHA256SUMS.txt\` on macOS).`,
    "",
  ].join("\n");
}

export function resolveSelectedTargets(targetArg?: string): ReleaseTarget[] {
  if (!targetArg || targetArg === "all") {
    return [...RELEASE_TARGETS];
  }
  const requested = targetArg
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    return [...RELEASE_TARGETS];
  }
  return requested.map((id) => {
    const match = RELEASE_TARGETS.find((t) => t.id === id || t.bunTarget === id);
    if (!match) {
      throw new Error(
        `Unknown release target "${id}". Available targets: ${RELEASE_TARGETS.map((t) => t.id).join(", ")}`,
      );
    }
    return match;
  });
}

export function packageTargetArchive(options: {
  rootDir: string;
  binaryPath: string;
  outDir: string;
  target: ReleaseTarget;
}): string {
  const { rootDir, binaryPath, outDir, target } = options;
  if (!existsSync(binaryPath) || !statSync(binaryPath).isFile() || statSync(binaryPath).size === 0) {
    throw new Error(`Missing or empty compiled binary for ${target.id}: ${binaryPath}`);
  }

  mkdirSync(outDir, { recursive: true });
  const stageParent = join(outDir, `.stage-${target.id}-`);
  const stageDir = mkdtempSync(stageParent);
  const archivePath = join(outDir, target.archive);

  try {
    const stagedBin = join(stageDir, "losql");
    cpSync(binaryPath, stagedBin);
    chmodSync(stagedBin, 0o755);

    for (const file of ARCHIVE_FILES) {
      const srcFile = join(rootDir, file);
      if (!existsSync(srcFile)) {
        throw new Error(`Missing required archive file: ${file}`);
      }
      cpSync(srcFile, join(stageDir, file));
    }

    rmSync(archivePath, { force: true });
    const tar = spawnSync(
      "tar",
      ["-czf", archivePath, "-C", stageDir, "losql", ...ARCHIVE_FILES],
      { encoding: "utf8" },
    );
    if (tar.status !== 0) {
      throw new Error(`tar failed for ${target.archive}: ${tar.stderr || tar.stdout}`);
    }
    return archivePath;
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

export function formatChecksumsManifest(outDir: string, archiveFileNames: readonly string[]): string {
  const lines: string[] = [];
  for (const name of archiveFileNames) {
    const filePath = join(outDir, name);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new Error(`Missing release archive for checksum: ${filePath}`);
    }
    const digest = createHash("sha256").update(readFileSync(filePath)).digest("hex");
    lines.push(`${digest}  ${name}`);
  }
  return `${lines.join("\n")}\n`;
}

export type ReleaseCliArgs =
  | { command: "help" }
  | { command: "check"; tag?: string }
  | { command: "notes"; tag?: string; outFile?: string }
  | { command: "bump"; version: string }
  | { command: "build"; target?: string; outDir?: string; tag?: string }
  | {
      command: "publish";
      tag?: string;
      outDir?: string;
      dryRun?: boolean;
      draft?: boolean;
      skipChecks?: boolean;
    };

export const RELEASE_USAGE = [
  "Usage: bun run scripts/release.ts <command> [options]",
  "",
  "Commands:",
  "  check [--tag <vX.Y.Z>]                  Verify version sync across package.json, README, landing page & CHANGELOG",
  "  bump <X.Y.Z>                            Update version in package.json, README.md, and landing/src/index.html",
  "  notes [--tag <vX.Y.Z>] [--out <file>]   Generate GitHub release notes from CHANGELOG.md",
  "  build [--target <list>] [--out-dir <d>] Cross-compile release binaries, package .tar.gz archives, and write SHA256SUMS.txt",
  "  publish [options]                       Verify, build all targets, tag, and publish the GitHub release via gh",
  "",
  "Publish options:",
  "  --tag <vX.Y.Z>       Release tag (defaults to v<package.json version>)",
  "  --out-dir <dir>      Output directory (defaults to dist/release)",
  "  --dry-run            Run all checks, builds, and notes generation without pushing tags or creating a GitHub release",
  "  --draft              Create the GitHub release as a draft",
  "  --skip-checks        Skip running `bun run check` and `bun run landing:build` before packaging",
].join("\n");

export function parseReleaseArgs(argv: readonly string[]): ReleaseCliArgs {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help") || argv[0] === "help") {
    return { command: "help" };
  }

  const [cmd, ...rest] = argv;
  if (cmd === "check") {
    let tag: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--tag") {
        tag = rest[++i];
        if (!tag) throw new Error("--tag requires a value");
      } else {
        throw new Error(`Unknown flag for check: ${rest[i]}`);
      }
    }
    return tag !== undefined ? { command: "check", tag } : { command: "check" };
  }

  if (cmd === "notes") {
    let tag: string | undefined;
    let outFile: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--tag") {
        tag = rest[++i];
        if (!tag) throw new Error("--tag requires a value");
      } else if (rest[i] === "--out") {
        outFile = rest[++i];
        if (!outFile) throw new Error("--out requires a path");
      } else {
        throw new Error(`Unknown flag for notes: ${rest[i]}`);
      }
    }
    return {
      command: "notes",
      ...(tag !== undefined ? { tag } : {}),
      ...(outFile !== undefined ? { outFile } : {}),
    };
  }

  if (cmd === "bump") {
    if (rest.length !== 1 || !rest[0]) {
      throw new Error("bump requires a single version argument (e.g. bun run scripts/release.ts bump 0.3.0)");
    }
    return { command: "bump", version: rest[0] };
  }

  if (cmd === "build") {
    let target: string | undefined;
    let outDir: string | undefined;
    let tag: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--target") {
        target = rest[++i];
        if (!target) throw new Error("--target requires a value");
      } else if (rest[i] === "--out-dir") {
        outDir = rest[++i];
        if (!outDir) throw new Error("--out-dir requires a value");
      } else if (rest[i] === "--tag") {
        tag = rest[++i];
        if (!tag) throw new Error("--tag requires a value");
      } else {
        throw new Error(`Unknown flag for build: ${rest[i]}`);
      }
    }
    return {
      command: "build",
      ...(target !== undefined ? { target } : {}),
      ...(outDir !== undefined ? { outDir } : {}),
      ...(tag !== undefined ? { tag } : {}),
    };
  }

  if (cmd === "publish") {
    let tag: string | undefined;
    let outDir: string | undefined;
    let dryRun: boolean | undefined;
    let draft: boolean | undefined;
    let skipChecks: boolean | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--tag") {
        tag = rest[++i];
        if (!tag) throw new Error("--tag requires a value");
      } else if (rest[i] === "--out-dir") {
        outDir = rest[++i];
        if (!outDir) throw new Error("--out-dir requires a value");
      } else if (rest[i] === "--dry-run") {
        dryRun = true;
      } else if (rest[i] === "--draft") {
        draft = true;
      } else if (rest[i] === "--skip-checks") {
        skipChecks = true;
      } else {
        throw new Error(`Unknown flag for publish: ${rest[i]}`);
      }
    }
    return {
      command: "publish",
      ...(tag !== undefined ? { tag } : {}),
      ...(outDir !== undefined ? { outDir } : {}),
      ...(dryRun ? { dryRun } : {}),
      ...(draft ? { draft } : {}),
      ...(skipChecks ? { skipChecks } : {}),
    };
  }

  throw new Error(`Unknown release command: ${cmd}`);
}

function readRepoSources(rootDir: string): VersionSources {
  return {
    packageJson: readFileSync(join(rootDir, "package.json"), "utf8"),
    readmeMd: readFileSync(join(rootDir, "README.md"), "utf8"),
    landingHtml: readFileSync(join(rootDir, "landing/src/index.html"), "utf8"),
    changelogMd: readFileSync(join(rootDir, "CHANGELOG.md"), "utf8"),
  };
}

function ensureAllPlatformDepsInstalled(rootDir: string, targets: readonly ReleaseTarget[]): void {
  const needsCrossPackages = targets.some(
    (t) => !existsSync(join(rootDir, "node_modules", `@opentui/core-${t.os}-${t.arch}`)),
  );
  if (!needsCrossPackages) return;

  console.log("Installing cross-platform @opentui/core native packages...");
  const install = spawnSync(
    process.execPath,
    ["install", "--os=*", "--cpu=*", "--frozen-lockfile"],
    { cwd: rootDir, stdio: "inherit" },
  );
  if (install.status !== 0) {
    throw new Error("bun install --os=* --cpu=* --frozen-lockfile failed");
  }
}

export async function buildReleaseArtifacts(options: {
  rootDir: string;
  outDir: string;
  targets: readonly ReleaseTarget[];
  version: string;
}): Promise<{ archives: string[]; checksumsPath: string; notesPath: string }> {
  const { rootDir, outDir, targets, version } = options;
  ensureAllPlatformDepsInstalled(rootDir, targets);

  // IMPORTANT: Build inside `outDir` (which resides on the workspace filesystem, not /tmp tmpfs)
  // because Bun's cross-target compiler links the output binary in place.
  mkdirSync(outDir, { recursive: true });
  const buildWorkDir = mkdtempSync(join(outDir, ".compile-"));
  const archiveNames: string[] = [];
  const archivePaths: string[] = [];

  try {
    for (const target of targets) {
      const compiledBin = join(buildWorkDir, `losql-${target.id}`);
      console.log(`Compiling ${target.id} (${target.bunTarget})...`);
      const result = await Bun.build({
        entrypoints: [join(rootDir, "src/main.ts")],
        target: "bun",
        plugins: [createSolidTransformPlugin()],
        compile: {
          target: target.bunTarget,
          outfile: compiledBin,
          autoloadBunfig: false,
        },
      });
      if (!result.success) {
        for (const log of result.logs) console.error(log);
        throw new Error(`Bun.build failed for ${target.id}`);
      }

      // Smoke-check the host target binary directly when running on the matching OS and CPU.
      if (target.os === process.platform && target.arch === process.arch) {
        const smoke = spawnSync(compiledBin, ["--version"], { encoding: "utf8" });
        if (smoke.status !== 0 || smoke.stdout.trim() !== `losql ${version}`) {
          throw new Error(
            `Host binary smoke test failed for ${target.id}: expected "losql ${version}", got "${smoke.stdout.trim()}" (exit ${smoke.status})`,
          );
        }
        const demoSmoke = spawnSync(
          compiledBin,
          ["exec", "-c", "demo", "--format", "json", "select count(*) as n from customers"],
          { encoding: "utf8" },
        );
        let parsedSmoke: unknown;
        try {
          parsedSmoke = JSON.parse(demoSmoke.stdout);
        } catch {
          parsedSmoke = null;
        }
        if (
          demoSmoke.status !== 0 ||
          !Array.isArray(parsedSmoke) ||
          (parsedSmoke[0] as { n?: unknown } | undefined)?.n !== 8
        ) {
          throw new Error(
            `Host binary demo query smoke test failed for ${target.id}: ${demoSmoke.stderr || demoSmoke.stdout}`,
          );
        }
      }

      const archivePath = packageTargetArchive({
        rootDir,
        binaryPath: compiledBin,
        outDir,
        target,
      });
      archiveNames.push(target.archive);
      archivePaths.push(archivePath);
      console.log(`Packaged ${target.archive}`);
    }
  } finally {
    rmSync(buildWorkDir, { recursive: true, force: true });
  }

  const checksumsPath = join(outDir, "SHA256SUMS.txt");
  const checksums = formatChecksumsManifest(outDir, archiveNames);
  writeFileSync(checksumsPath, checksums);
  console.log(`Wrote ${checksumsPath}`);

  const changelog = readFileSync(join(rootDir, "CHANGELOG.md"), "utf8");
  const notes = formatReleaseNotes({ version, changelog });
  const notesPath = join(outDir, "RELEASE_NOTES.md");
  writeFileSync(notesPath, notes);
  console.log(`Wrote ${notesPath}`);

  return { archives: archivePaths, checksumsPath, notesPath };
}

function runCommandOrThrow(cmd: string, args: string[], cwd: string): void {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(" ")}`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let parsed: ReleaseCliArgs;
  try {
    parsed = parseReleaseArgs(argv);
  } catch (err) {
    console.error(`release: ${err instanceof Error ? err.message : String(err)}\n\n${RELEASE_USAGE}`);
    return 2;
  }

  if (parsed.command === "help") {
    console.log(RELEASE_USAGE);
    return 0;
  }

  try {
    if (parsed.command === "check") {
      const sources = readRepoSources(rootDir);
      const problems = checkVersionSources(sources, parsed.tag);
      if (problems.length > 0) {
        for (const p of problems) console.error(`release check: ${p}`);
        return 1;
      }
      const version = readPackageVersion(sources.packageJson);
      console.log(`Release check passed: v${version}`);
      return 0;
    }

    if (parsed.command === "bump") {
      const sources = readRepoSources(rootDir);
      const current = readPackageVersion(sources.packageJson);
      const updated = bumpVersionSources(sources, parsed.version);
      writeFileSync(join(rootDir, "package.json"), updated.packageJson);
      writeFileSync(join(rootDir, "README.md"), updated.readmeMd);
      writeFileSync(join(rootDir, "landing/src/index.html"), updated.landingHtml);
      console.log(`Bumped version ${current} -> ${parsed.version}`);
      return 0;
    }

    if (parsed.command === "notes") {
      const sources = readRepoSources(rootDir);
      const version = parsed.tag ? normalizeTag(parsed.tag)?.version : readPackageVersion(sources.packageJson);
      if (!version) {
        console.error(`release notes: invalid tag "${parsed.tag}"`);
        return 2;
      }
      const notes = formatReleaseNotes({ version, changelog: sources.changelogMd });
      if (parsed.outFile) {
        const outPath = resolve(rootDir, parsed.outFile);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, notes);
      } else {
        process.stdout.write(notes);
      }
      return 0;
    }

    if (parsed.command === "build") {
      const sources = readRepoSources(rootDir);
      const problems = checkVersionSources(sources, parsed.tag);
      if (problems.length > 0) {
        for (const p of problems) console.error(`release build: ${p}`);
        return 1;
      }
      const version = readPackageVersion(sources.packageJson);
      const outDir = resolve(rootDir, parsed.outDir ?? "dist/release");
      const targets = resolveSelectedTargets(parsed.target);
      await buildReleaseArtifacts({ rootDir, outDir, targets, version });
      return 0;
    }

    if (parsed.command === "publish") {
      const sources = readRepoSources(rootDir);
      const problems = checkVersionSources(sources, parsed.tag);
      if (problems.length > 0) {
        for (const p of problems) console.error(`release publish: ${p}`);
        return 1;
      }
      const version = readPackageVersion(sources.packageJson);
      const tag = `v${version}`;

      if (!parsed.dryRun) {
        const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd: rootDir, encoding: "utf8" });
        if (gitStatus.status !== 0 || gitStatus.stdout.trim().length > 0) {
          throw new Error("Working tree is not clean. Commit or stash changes before publishing a release.");
        }
      }

      if (!parsed.skipChecks) {
        console.log("Running typecheck and test suite...");
        runCommandOrThrow(process.execPath, ["run", "check"], rootDir);
        console.log("Verifying static landing page build...");
        runCommandOrThrow(process.execPath, ["run", "landing:build"], rootDir);
      }

      const outDir = resolve(rootDir, parsed.outDir ?? "dist/release");
      rmSync(outDir, { recursive: true, force: true });
      const { archives, checksumsPath, notesPath } = await buildReleaseArtifacts({
        rootDir,
        outDir,
        targets: RELEASE_TARGETS,
        version,
      });

      if (parsed.dryRun) {
        console.log(`Dry run complete for ${tag}. Artifacts written to ${outDir}`);
        return 0;
      }

      // Create and push tag if not already on remote
      const localTag = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
        cwd: rootDir,
        encoding: "utf8",
      });
      if (localTag.status !== 0) {
        console.log(`Creating annotated git tag ${tag}...`);
        runCommandOrThrow("git", ["tag", "-a", tag, "-m", `losql ${tag}`], rootDir);
      }
      console.log(`Pushing tag ${tag} to origin...`);
      runCommandOrThrow("git", ["push", "origin", `refs/tags/${tag}`], rootDir);

      const assets = [...archives, checksumsPath, join(rootDir, "install.sh")];
      const existingRelease = spawnSync("gh", ["release", "view", tag], {
        cwd: rootDir,
        encoding: "utf8",
      });
      if (existingRelease.status === 0) {
        console.log(`Updating existing GitHub release ${tag}...`);
        runCommandOrThrow("gh", ["release", "upload", tag, "--clobber", ...assets], rootDir);
        runCommandOrThrow("gh", ["release", "edit", tag, "--title", `losql ${tag}`, "--notes-file", notesPath], rootDir);
      } else {
        console.log(`Creating GitHub release ${tag}...`);
        const createArgs = [
          "release",
          "create",
          tag,
          "--title",
          `losql ${tag}`,
          "--notes-file",
          notesPath,
          ...(parsed.draft ? ["--draft"] : []),
          ...assets,
        ];
        runCommandOrThrow("gh", createArgs, rootDir);
      }

      console.log(`Published release ${tag}`);
      return 0;
    }
  } catch (err) {
    console.error(`release: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
