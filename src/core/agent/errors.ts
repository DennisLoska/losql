export type ProviderErrorKind = "missing" | "auth" | "quota" | "timeout" | "cancelled" | "other";

export class ProviderError extends Error {
  kind: ProviderErrorKind;

  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
  }
}
