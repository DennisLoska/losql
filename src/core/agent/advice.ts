import type { ProviderErrorKind } from "./errors";
import type { ProviderAdapter } from "./providers/types";

/** What a hint names of the Provider that failed. */
export interface ProviderHintSource {
  label: string;
  /** The command the user runs to log in. */
  binary: string;
  installHint: string;
}

/** The Provider of `adapter` as a hint names it. */
export function providerHintSource(adapter: ProviderAdapter): ProviderHintSource {
  return {
    label: adapter.label,
    binary: adapter.binaries[0] ?? adapter.id,
    installHint: adapter.installHint,
  };
}

/**
 * What to do about a Provider error of `kind`: one line, or "" when there is nothing to advise (a
 * cancelled Turn, an error of no known kind, or a Provider-specific kind without a Provider).
 * `clean` makes the text taken from the Provider safe to show (the interface's own cleaning, or
 * escaping for a terminal); it is applied to the Provider's label, binary and install hint.
 */
export function providerErrorHint(
  kind: ProviderErrorKind | "protocol",
  provider: ProviderHintSource | null,
  clean: (text: string) => string = (text) => text,
): string {
  if (kind === "cancelled" || kind === "other") return "";
  if (kind === "protocol") {
    return "The reply could not be understood. Try again, or pick another model with space m.";
  }
  if (!provider) return "";
  if (kind === "auth") {
    return `Run \`${clean(provider.binary)}\` once in a terminal to log in, then try again.`;
  }
  if (kind === "quota") {
    return `${clean(provider.label)} has reached its usage limit. Try again later or switch provider with space p.`;
  }
  if (kind === "missing") {
    return clean(provider.installHint);
  }
  if (kind === "timeout") {
    return `${clean(provider.label)} did not answer in time. Try again, or pick a faster model with space m.`;
  }
  return "";
}

/**
 * A Provider error as it is reported: its own message, and the hint for its kind ("" when there is
 * none).
 */
export function describeProviderError(
  kind: ProviderErrorKind | "protocol",
  message: string,
  provider: ProviderHintSource | null,
  clean?: (text: string) => string,
): { message: string; hint: string } {
  return { message, hint: providerErrorHint(kind, provider, clean) };
}
