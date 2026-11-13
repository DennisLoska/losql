import { statementAt } from "../sql/statements";
import { offsetToPosition, type Position, positionToOffset, type Range, type TextBuffer } from "./buffer";

/** A statementRange option for VimEngine: the SQL Statement around a position, without its semicolon. */
export function sqlStatementRange(buffer: TextBuffer): (position: Position) => Range | null {
  return (position: Position): Range | null => {
    const offset = positionToOffset(buffer, position);
    const stmt = statementAt(buffer.text(), offset);
    if (!stmt) return null;
    return {
      start: offsetToPosition(buffer, stmt.start),
      end: offsetToPosition(buffer, stmt.end),
    };
  };
}
