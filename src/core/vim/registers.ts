export interface RegisterEntry {
  text: string;
  linewise: boolean;
}

export class Registers {
  private readonly entries = new Map<string, RegisterEntry>();

  write(name: string | null, entry: RegisterEntry, isYank: boolean): void {
    const regName = name ?? '"';
    if (regName === "_") return;
    if (regName === "+" || regName === "*" || regName === '"') {
      this.entries.set('"', entry);
    } else {
      this.entries.set(regName, entry);
      this.entries.set('"', entry);
    }
    if (isYank) {
      this.entries.set("0", entry);
    }
  }

  read(name: string | null): RegisterEntry | null {
    const regName = name ?? '"';
    if (regName === "_") return null;
    const key = regName === "+" || regName === "*" ? '"' : regName;
    return this.entries.get(key) ?? null;
  }
}
