import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ARCHIVE_FILES,
  RELEASE_TARGETS,
  bumpVersionSources,
  checkVersionSources,
  extractChangelogSection,
  formatChecksumsManifest,
  formatReleaseNotes,
  isValidSemver,
  normalizeTag,
  packageTargetArchive,
  parseReleaseArgs,
  resolveSelectedTargets,
} from "./release";

const ROOT = resolve(import.meta.dir, "..");

describe("version & tag validation", () => {
  test("validates strict semver X.Y.Z and normalised vX.Y.Z tags", () => {
    expect(isValidSemver("0.2.0")).toBe(true);
    expect(isValidSemver("1.0.0")).toBe(true);
    expect(isValidSemver("10.20.30")).toBe(true);
    expect(isValidSemver("v0.2.0")).toBe(false);
    expect(isValidSemver("0.2")).toBe(false);
    expect(isValidSemver("0.2.0-beta.1")).toBe(false);
    expect(isValidSemver("")).toBe(false);

    expect(normalizeTag("0.2.0")).toEqual({ version: "0.2.0", tag: "v0.2.0" });
    expect(normalizeTag("v0.2.0")).toEqual({ version: "0.2.0", tag: "v0.2.0" });
    expect(normalizeTag("invalid")).toBeNull();
    expect(normalizeTag("v1.2")).toBeNull();
  });

  test("checkVersionSources verifies package.json, README.md, landing/src/index.html, and CHANGELOG.md", () => {
    const validSources = {
      packageJson: JSON.stringify({ name: "losql", version: "0.2.0" }, null, 2),
      readmeMd: '<img src="https://img.shields.io/badge/version-0.2.0-9ece6a?style=flat-square" alt="version 0.2.0" />',
      landingHtml:
        '<script type="application/ld+json">{"softwareVersion":"0.2.0"}</script><code id="install-command">curl -fsSL https://raw.githubusercontent.com/DennisLoska/losql/v0.2.0/install.sh | sh</code><p class="footer-facts">Open Source · MIT · SQLite &amp; Postgres · Single Binary · Omarchy First · v0.2.0</p>',
      changelogMd: "# Changelog\n\n## [0.2.0] - 2026-11-16\n\n- Initial release.\n",
    };

    expect(checkVersionSources(validSources)).toEqual([]);
    expect(checkVersionSources(validSources, "v0.2.0")).toEqual([]);
    expect(checkVersionSources(validSources, "0.2.0")).toEqual([]);

    const mismatchTag = checkVersionSources(validSources, "v0.3.0");
    expect(mismatchTag.length).toBeGreaterThan(0);
    expect(mismatchTag[0]).toContain("0.3.0");

    const driftedReadme = checkVersionSources({
      ...validSources,
      readmeMd: '<img src="https://img.shields.io/badge/version-0.1.0-9ece6a?style=flat-square" alt="version 0.1.0" />',
    });
    expect(driftedReadme.some((p) => p.includes("README.md"))).toBe(true);

    const driftedLanding = checkVersionSources({
      ...validSources,
      landingHtml:
        '<script type="application/ld+json">{"softwareVersion":"0.1.0"}</script><code id="install-command">curl -fsSL https://raw.githubusercontent.com/DennisLoska/losql/v0.2.0/install.sh | sh</code><p class="footer-facts">Open Source · MIT · SQLite &amp; Postgres · Single Binary · Omarchy First · v0.2.0</p>',
    });
    expect(driftedLanding.some((p) => p.includes("landing/src/index.html"))).toBe(true);

    const driftedInstallUrl = checkVersionSources({
      ...validSources,
      landingHtml:
        '<script type="application/ld+json">{"softwareVersion":"0.2.0"}</script><code id="install-command">curl -fsSL https://raw.githubusercontent.com/DennisLoska/losql/v0.1.0/install.sh | sh</code><p class="footer-facts">Open Source · MIT · SQLite &amp; Postgres · Single Binary · Omarchy First · v0.2.0</p>',
    });
    expect(driftedInstallUrl.some((p) => p.includes("install.sh"))).toBe(true);

    const missingChangelog = checkVersionSources({
      ...validSources,
      changelogMd: "# Changelog\n\n## [0.1.0] - 2026-11-01\n\n- Old release.\n",
    });
    expect(missingChangelog.some((p) => p.includes("CHANGELOG.md"))).toBe(true);
  });

  test("bumpVersionSources updates version across package.json, README.md, and landing/src/index.html", () => {
    const initial = {
      packageJson: '{\n  "name": "losql",\n  "version": "0.2.0"\n}\n',
      readmeMd:
        'Header\n<img src="https://img.shields.io/badge/version-0.2.0-9ece6a?style=flat-square" alt="version 0.2.0" />\nFooter\n',
      landingHtml:
        '<script type="application/ld+json">{"softwareVersion":"0.2.0"}</script>\n<code id="install-command">curl -fsSL https://raw.githubusercontent.com/DennisLoska/losql/v0.2.0/install.sh | sh</code>\n<p class="footer-facts">Open Source · MIT · SQLite &amp; Postgres · Single Binary · Omarchy First · v0.2.0</p>\n',
      changelogMd: "# Changelog\n\n## [0.3.0] - 2026-11-16\n\n- Next release.\n",
    };

    const bumped = bumpVersionSources(initial, "0.3.0");
    expect(JSON.parse(bumped.packageJson).version).toBe("0.3.0");
    expect(bumped.readmeMd).toContain("version-0.3.0-9ece6a");
    expect(bumped.readmeMd).toContain('alt="version 0.3.0"');
    expect(bumped.landingHtml).toContain('"softwareVersion":"0.3.0"');
    expect(bumped.landingHtml).toContain("https://raw.githubusercontent.com/DennisLoska/losql/v0.3.0/install.sh");
    expect(bumped.landingHtml).toContain("Omarchy First · v0.3.0</p>");
    expect(checkVersionSources({ ...bumped, changelogMd: initial.changelogMd }, "v0.3.0")).toEqual([]);
  });
});

describe("changelog & release notes generation", () => {
  const sampleChangelog = [
    "# Changelog",
    "",
    "All notable changes to losql are documented in this file.",
    "",
    "## [0.2.0] - 2026-11-16",
    "",
    "### Highlights",
    "- Modal Vim SQL editor with `is`/`as` Statement text objects.",
    "- Read-only Agent steps driving local coding CLIs.",
    "",
    "## [0.1.0] - 2026-11-01",
    "",
    "- Initial prototype.",
    "",
  ].join("\n");

  test("extractChangelogSection extracts the matching version section", () => {
    const section = extractChangelogSection(sampleChangelog, "0.2.0");
    expect(section).toContain("### Highlights");
    expect(section).toContain("Modal Vim SQL editor");
    expect(section).not.toContain("0.1.0");
    expect(section).not.toContain("Initial prototype");
    expect(extractChangelogSection(sampleChangelog, "9.9.9")).toBeNull();
  });

  test("formatReleaseNotes includes changelog section, install snippet, and platform asset table", () => {
    const notes = formatReleaseNotes({
      version: "0.2.0",
      changelog: sampleChangelog,
      repo: "DennisLoska/losql",
    });
    expect(notes).toContain("### Highlights");
    expect(notes).toContain("curl -fsSL https://raw.githubusercontent.com/DennisLoska/losql/v0.2.0/install.sh | sh");
    for (const target of RELEASE_TARGETS) {
      expect(notes).toContain(target.archive);
    }
    expect(notes).toContain("SHA256SUMS.txt");
  });
});

describe("target matrix, packaging, and checksums", () => {
  test("RELEASE_TARGETS covers Linux and macOS on x64 and arm64", () => {
    expect(RELEASE_TARGETS.map((t) => t.id)).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
    ]);
    expect(RELEASE_TARGETS.map((t) => t.bunTarget)).toEqual([
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-darwin-x64",
      "bun-darwin-arm64",
    ]);
    expect(RELEASE_TARGETS.map((t) => t.archive)).toEqual([
      "losql-linux-x64.tar.gz",
      "losql-linux-arm64.tar.gz",
      "losql-darwin-x64.tar.gz",
      "losql-darwin-arm64.tar.gz",
    ]);
  });

  test("resolveSelectedTargets resolves all or a subset of targets", () => {
    expect(resolveSelectedTargets(undefined).map((t) => t.id)).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
    ]);
    expect(resolveSelectedTargets("linux-x64,darwin-arm64").map((t) => t.id)).toEqual([
      "linux-x64",
      "darwin-arm64",
    ]);
    expect(() => resolveSelectedTargets("windows-x64")).toThrow(/Unknown release target/);
  });

  test("packageTargetArchive bundles losql binary, LICENSE, NOTICE, and README.md and formatChecksumsManifest computes SHA-256", () => {
    const dir = mkdtempSync(join(tmpdir(), "losql-release-pkg-"));
    try {
      const binPath = join(dir, "losql-bin");
      writeFileSync(binPath, "#!/bin/sh\necho 'losql 0.2.0'\n", { mode: 0o755 });
      const outDir = join(dir, "dist");
      mkdirSync(outDir, { recursive: true });

      const target = RELEASE_TARGETS[0]!;
      const archivePath = packageTargetArchive({
        rootDir: ROOT,
        binaryPath: binPath,
        outDir,
        target,
      });

      expect(archivePath).toBe(join(outDir, "losql-linux-x64.tar.gz"));
      expect(existsSync(archivePath)).toBe(true);
      expect(statSync(archivePath).size).toBeGreaterThan(0);

      const list = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
      expect(list.status).toBe(0);
      const entries = list.stdout.trim().split("\n").sort();
      expect(entries).toEqual(["losql", ...ARCHIVE_FILES].sort());

      const extractDir = join(dir, "extracted");
      mkdirSync(extractDir, { recursive: true });
      const extract = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], { encoding: "utf8" });
      expect(extract.status).toBe(0);
      const runExtracted = spawnSync(join(extractDir, "losql"), [], { encoding: "utf8" });
      expect(runExtracted.status).toBe(0);
      expect(runExtracted.stdout.trim()).toBe("losql 0.2.0");

      const manifest = formatChecksumsManifest(outDir, [target.archive]);
      const expectedHash = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
      expect(manifest).toBe(`${expectedHash}  ${target.archive}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parseReleaseArgs parses CLI commands and flags", () => {
    expect(parseReleaseArgs(["check"])).toEqual({ command: "check" });
    expect(parseReleaseArgs(["check", "--tag", "v0.2.0"])).toEqual({ command: "check", tag: "v0.2.0" });
    expect(parseReleaseArgs(["notes", "--tag", "v0.2.0"])).toEqual({ command: "notes", tag: "v0.2.0" });
    expect(parseReleaseArgs(["bump", "0.3.0"])).toEqual({ command: "bump", version: "0.3.0" });
    expect(parseReleaseArgs(["build", "--target", "linux-x64", "--out-dir", "dist/custom"])).toEqual({
      command: "build",
      target: "linux-x64",
      outDir: "dist/custom",
    });
    expect(parseReleaseArgs(["publish", "--dry-run", "--skip-checks"])).toEqual({
      command: "publish",
      dryRun: true,
      skipChecks: true,
    });
    expect(parseReleaseArgs(["--help"])).toEqual({ command: "help" });
  });
});

describe("repository maturity files & install.sh", () => {
  test("current repository passes checkVersionSources for v0.2.0", () => {
    const problems = checkVersionSources(
      {
        packageJson: readFileSync(join(ROOT, "package.json"), "utf8"),
        readmeMd: readFileSync(join(ROOT, "README.md"), "utf8"),
        landingHtml: readFileSync(join(ROOT, "landing/src/index.html"), "utf8"),
        changelogMd: readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"),
      },
      "v0.2.0",
    );
    expect(problems).toEqual([]);
  });

  test("install.sh installs a release archive and verifies SHA256SUMS.txt using a local file:// base URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "losql-installer-test-"));
    try {
      const releaseDir = join(dir, "releases", "download", "v0.2.0");
      mkdirSync(releaseDir, { recursive: true });

      const fakeBin = join(dir, "fake-losql");
      writeFileSync(fakeBin, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"losql 0.2.0\"; else echo \"ran $*\"; fi\n", {
        mode: 0o755,
      });

      const archiveNames: string[] = [];
      for (const target of RELEASE_TARGETS) {
        packageTargetArchive({
          rootDir: ROOT,
          binaryPath: fakeBin,
          outDir: releaseDir,
          target,
        });
        archiveNames.push(target.archive);
      }
      const checksums = formatChecksumsManifest(releaseDir, archiveNames);
      writeFileSync(join(releaseDir, "SHA256SUMS.txt"), checksums);

      const binInstallDir = join(dir, "bin");
      const installScript = join(ROOT, "install.sh");
      expect(existsSync(installScript)).toBe(true);

      const helpRun = spawnSync("sh", [installScript, "--help"], { encoding: "utf8" });
      expect(helpRun.status).toBe(0);
      expect(helpRun.stdout).toContain("install.sh");

      const installRun = spawnSync(
        "sh",
        [installScript, "--version", "v0.2.0", "--bin-dir", binInstallDir],
        {
          cwd: dir,
          env: {
            ...process.env,
            LOSQL_RELEASE_BASE_URL: `file://${join(dir, "releases")}`,
          },
          encoding: "utf8",
        },
      );
      expect(installRun.status).toBe(0);
      const installedBinary = join(binInstallDir, "losql");
      expect(existsSync(installedBinary)).toBe(true);

      const verRun = spawnSync(installedBinary, ["--version"], { encoding: "utf8" });
      expect(verRun.status).toBe(0);
      expect(verRun.stdout.trim()).toBe("losql 0.2.0");

      // Tamper with checksums and verify installer rejects tampered archive
      writeFileSync(
        join(releaseDir, "SHA256SUMS.txt"),
        checksums.replace(/^[0-9a-f]{64}/gm, "0".repeat(64)),
      );
      const badRun = spawnSync(
        "sh",
        [installScript, "--version", "v0.2.0", "--bin-dir", join(dir, "bin-bad")],
        {
          cwd: dir,
          env: {
            ...process.env,
            LOSQL_RELEASE_BASE_URL: `file://${join(dir, "releases")}`,
          },
          encoding: "utf8",
        },
      );
      expect(badRun.status).not.toBe(0);
      expect(badRun.stderr.toLowerCase()).toContain("checksum");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maturity documents and GitHub templates exist and are non-empty", () => {
    for (const relPath of [
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "install.sh",
      ".github/workflows/release.yml",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/pull_request_template.md",
    ]) {
      const fullPath = join(ROOT, relPath);
      expect(existsSync(fullPath)).toBe(true);
      expect(statSync(fullPath).size).toBeGreaterThan(0);
    }
  });
});
