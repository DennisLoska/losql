import type { AppApi } from "../app";
import { keyLabel } from "./key-label";
import type { SelectOption } from "./select";

export async function openPalette(api: AppApi): Promise<void> {
  const leader = api.config.config().leader;
  const available = api.commands.registry
    .all()
    .filter((cmd) => api.commands.registry.isAvailable(cmd, api));

  const options: SelectOption<string>[] = available.map((cmd) => {
    const hint = cmd.keys
      ? keyLabel(cmd.keys, leader)
      : cmd.ex && cmd.ex.length > 0 && cmd.ex[0]
        ? `:${cmd.ex[0]}`
        : "";
    return {
      title: cmd.title,
      value: cmd.id,
      category: cmd.group,
      hint: hint || undefined,
    };
  });

  const selectedId = await api.dialog.select({
    title: "Commands",
    options,
  });

  if (selectedId !== null) {
    await api.commands.run(selectedId, "");
  }
}
