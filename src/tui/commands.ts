import type { AppApi } from "./app";
import { openHelp } from "./ui/help";
import { keyLabel } from "./ui/key-label";
import { openPalette } from "./ui/palette";

export { keyLabel };

export function registerAppCommands(api: AppApi): void {
  api.commands.register({
    id: "app.quit",
    title: "Quit",
    ex: ["quit", "q", "qa"],
    run: (ctx) => ctx.quit(),
  });

  api.commands.register({
    id: "app.help",
    title: "Help",
    ex: ["help"],
    keys: "?",
    run: (ctx) => {
      openHelp(ctx);
    },
  });

  api.commands.register({
    id: "app.palette",
    title: "Command palette",
    run: (ctx) => openPalette(ctx),
  });

  api.commands.register({
    id: "app.set",
    title: "Set an option",
    ex: ["set"],
    run: async (ctx, args) => {
      const word = args.trim();
      if (word.length === 0) {
        const cfg = ctx.config.config();
        ctx.status.say(
          `transparent=${cfg.transparent ? "on" : "off"} animations=${cfg.animations ? "on" : "off"} maxrows=${cfg.results.maxRows}`,
        );
        return;
      }

      if (word === "transparent") {
        await ctx.theme.setTransparent(true);
        return;
      }

      if (word === "notransparent") {
        await ctx.theme.setTransparent(false);
        return;
      }

      if (word === "animations") {
        await ctx.config.set((c) => ({ ...c, animations: true }));
        return;
      }

      if (word === "noanimations") {
        await ctx.config.set((c) => ({ ...c, animations: false }));
        return;
      }

      if (word.startsWith("maxrows=")) {
        const raw = word.slice("maxrows=".length);
        const n = Number(raw);
        if (!/^\d+$/.test(raw) || n < 1 || n > 1_000_000) {
          throw new Error(`Invalid value for maxrows: ${raw}`);
        }
        await ctx.config.set((c) => ({
          ...c,
          results: { ...c.results, maxRows: n },
        }));
        return;
      }

      throw new Error(`Unknown option: ${word}`);
    },
  });

  api.commands.register({
    id: "theme.set",
    title: "Set the theme",
    ex: ["theme"],
    run: async (ctx, args) => {
      const name = args.trim();
      if (name.length > 0) {
        await ctx.theme.select(name);
        return;
      }
      if (ctx.commands.registry.byId("theme.pick")) {
        await ctx.commands.run("theme.pick", "");
      } else {
        ctx.status.say(`theme: ${ctx.theme.name()}`);
      }
    },
  });

  api.commands.register({
    id: "pane.schema",
    title: "Schema: show, focus or hide",
    keys: "e",
    run: (ctx) => {
      ctx.focus.toggle("schema");
    },
  });

  api.commands.register({
    id: "results.zoom",
    title: "Zoom results",
    ex: ["zoom"],
    keys: "z",
    run: (ctx) => {
      ctx.focus.toggleZoom();
    },
  });

  api.commands.register({
    id: "session.connect",
    title: "Connect",
    ex: ["connect"],
    run: async (ctx, args) => {
      const arg = args.trim();
      if (arg.length > 0) {
        const res = await ctx.session.connect(arg);
        if (!res.ok) {
          ctx.toast.show({
            title: "Could not connect",
            message: res.message,
            kind: "error",
          });
        }
        return;
      }
      if (ctx.commands.registry.byId("connections.pick")) {
        await ctx.commands.run("connections.pick", "");
      } else {
        ctx.status.say("Usage: :connect <name, URL or path>");
      }
    },
  });

  api.commands.register({
    id: "session.refresh",
    title: "Refresh the schema",
    ex: ["refresh"],
    run: async (ctx) => {
      await ctx.session.refreshSchema();
    },
  });
}

