import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  target: "bun",
  plugins: [createSolidTransformPlugin()],
  compile: {
    outfile: "./losql",
    autoloadBunfig: false, // the binary must not look for bunfig.toml's preload at runtime
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log("Build complete: ./losql");
