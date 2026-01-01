import { Server } from "./server/app";

await Server.start();
await import("./tui/app");

process.on("exit", () => {
  Server.stop();
});
