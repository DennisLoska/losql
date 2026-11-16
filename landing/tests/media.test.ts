import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MEDIA_DIR = join(ROOT, "landing", "public", "media");
const FONTS_DIR = join(ROOT, "landing", "public", "fonts");
const README_DIR = join(ROOT, "readme");

const REQUIRED_STATIC = [
  "hero.webp",
  "editor.webp",
  "agent.webp",
  "json.webp",
  "record.webp",
  "zoom.webp",
  "providers.webp",
  "themes.webp",
  "menu.webp",
  "onboarding.webp",
  "omarchy.webp",
  "omarchy-transparent.webp",
];

const REQUIRED_ANIMATED = [
  "workflow-tour.webp",
  "workflow-tour.gif",
  "recording-vim.webp",
  "recording-vim.gif",
  "recording-agent.webp",
  "recording-agent.gif",
  "recording-omarchy.webp",
  "recording-omarchy.gif",
];

const REQUIRED_FONTS = [
  "PlusJakartaSans-latin.woff2",
  "JetBrainsMono-latin.woff2",
  "OFL-PlusJakartaSans.txt",
  "OFL-JetBrainsMono.txt",
];

describe("landing media and fonts", () => {
  test("self-hosted WOFF2 fonts and OFL licenses exist", () => {
    for (const file of REQUIRED_FONTS) {
      const full = join(FONTS_DIR, file);
      expect(existsSync(full)).toBe(true);
      expect(statSync(full).size).toBeGreaterThan(100);
    }
  });

  test("all static WebP screenshots and animated WebP/GIF recordings exist and are valid", () => {
    for (const file of [...REQUIRED_STATIC, ...REQUIRED_ANIMATED]) {
      const full = join(MEDIA_DIR, file);
      expect(existsSync(full)).toBe(true);
      const buf = readFileSync(full);
      expect(buf.byteLength).toBeGreaterThan(2048);
      if (file.endsWith(".webp")) {
        expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(buf.subarray(8, 12).toString("ascii")).toBe("WEBP");
      } else if (file.endsWith(".gif")) {
        expect(buf.subarray(0, 4).toString("ascii")).toBe("GIF8");
      }
    }
  });

  test("manifest.json tracks sha256 and dimensions for all media files", () => {
    const manifestPath = join(MEDIA_DIR, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      binarySha256: string;
      assets: Record<string, { sha256: string; bytes: number; width: number; height: number; animated?: boolean; frames?: number }>;
    };
    expect(typeof manifest.binarySha256).toBe("string");
    expect(manifest.binarySha256.length).toBe(64);

    for (const file of [...REQUIRED_STATIC, ...REQUIRED_ANIMATED]) {
      const entry = manifest.assets[file];
      expect(entry).toBeDefined();
      const buf = readFileSync(join(MEDIA_DIR, file));
      const sha = createHash("sha256").update(buf).digest("hex");
      expect(entry!.sha256).toBe(sha);
      expect(entry!.bytes).toBe(buf.byteLength);
      expect(entry!.width).toBeGreaterThanOrEqual(800);
      expect(entry!.height).toBeGreaterThanOrEqual(450);
    }

    for (const anim of REQUIRED_ANIMATED) {
      expect(manifest.assets[anim]!.animated).toBe(true);
      expect(manifest.assets[anim]!.frames).toBeGreaterThanOrEqual(3);
    }
  });

  test("readme/*.webp screenshots match the latest captured media", () => {
    for (const name of [
      "hero.webp",
      "editor.webp",
      "agent.webp",
      "json.webp",
      "record.webp",
      "zoom.webp",
      "providers.webp",
      "themes.webp",
      "menu.webp",
      "onboarding.webp",
    ]) {
      const readmeBuf = readFileSync(join(README_DIR, name));
      const mediaBuf = readFileSync(join(MEDIA_DIR, name));
      expect(readmeBuf.equals(mediaBuf)).toBe(true);
    }
  });
});
