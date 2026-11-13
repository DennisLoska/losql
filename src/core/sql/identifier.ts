import { isReservedWord } from "./keywords";

const PLAIN_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Writes a name of a Relation, column or schema so that the database reads it
 * as that name: unchanged when it is a plain lower-case word that is not
 * reserved, otherwise in double quotes with inner double quotes doubled.
 */
export function quoteIdentifier(name: string): string {
  if (PLAIN_IDENTIFIER_RE.test(name) && !isReservedWord(name)) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}
