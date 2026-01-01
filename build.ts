import solidTransformPlugin from "@opentui/solid/bun-plugin";

await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  target: "bun",
  plugins: [solidTransformPlugin],
});
