import solidTransformPlugin from "@opentui/solid/bun-plugin";
import { $ } from "bun";

// Step 1: Bundle with SolidJS transformation
const bundleResult = await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  target: "bun",
  plugins: [solidTransformPlugin],
});

if (!bundleResult.success) {
  console.error("Bundle failed:");
  for (const log of bundleResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Step 2: Copy the parser worker to dist
await $`cp node_modules/@opentui/core/parser.worker.js dist/parser.worker.js`;

// Step 3: Compile to standalone binary with worker as additional entrypoint
const compileResult = await Bun.build({
  entrypoints: ["./dist/main.js", "./dist/parser.worker.js"],
  compile: {
    outfile: "./losql",
    autoloadBunfig: false, // Don't load bunfig.toml at runtime (fixes preload error)
  },
});

if (!compileResult.success) {
  console.error("Compile failed:");
  for (const log of compileResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Build complete: ./losql");
