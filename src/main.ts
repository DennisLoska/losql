import { Server } from "./server/app";

async function cleanup() {
  await Server.stop();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

await Server.start();
await import("./tui/app");
