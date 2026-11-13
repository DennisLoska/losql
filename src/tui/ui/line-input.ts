import { batch, createSignal } from "solid-js";
import type { Key } from "../../core/vim/keys";
import { graphemes } from "./cells";

export interface LineInput {
  text(): string;
  cursor(): number;
  set(text: string, cursor?: number): void;
  feed(key: Key): boolean;
  paste(text: string): void;
}

export interface GraphemeSegment {
  segment: string;
  index: number;
  end: number;
}

export function segmentGraphemes(text: string): GraphemeSegment[] {
  const result: GraphemeSegment[] = [];
  for (const s of graphemes.segment(text)) {
    result.push({
      segment: s.segment,
      index: s.index,
      end: s.index + s.segment.length,
    });
  }
  return result;
}

export function clampToGraphemeBoundary(text: string, index: number): number {
  if (index <= 0 || text.length === 0) return 0;
  if (index >= text.length) return text.length;
  let boundary = 0;
  for (const s of graphemes.segment(text)) {
    const end = s.index + s.segment.length;
    if (end <= index) {
      boundary = end;
    } else {
      break;
    }
  }
  return boundary;
}

function prevGraphemeBoundary(text: string, index: number): number {
  const clamped = clampToGraphemeBoundary(text, index);
  if (clamped <= 0) return 0;
  let prev = 0;
  for (const s of graphemes.segment(text)) {
    if (s.index >= clamped) break;
    prev = s.index;
  }
  return prev;
}

function nextGraphemeBoundary(text: string, index: number): number {
  const clamped = clampToGraphemeBoundary(text, index);
  if (clamped >= text.length) return text.length;
  for (const s of graphemes.segment(text)) {
    const end = s.index + s.segment.length;
    if (end > clamped) return end;
  }
  return text.length;
}

export function createLineInput(options?: { initial?: string; multiline?: boolean }): LineInput {
  const initialText = options?.initial ?? "";
  const multiline = options?.multiline ?? false;
  const [text, setText] = createSignal(initialText);
  const [cursor, setCursor] = createSignal(clampToGraphemeBoundary(initialText, initialText.length));

  return {
    text,
    cursor,
    set(next: string, nextCursor?: number): void {
      const target = nextCursor === undefined ? next.length : nextCursor;
      batch(() => {
        setText(next);
        setCursor(clampToGraphemeBoundary(next, target));
      });
    },
    feed(key: Key): boolean {
      const currentText = text();
      const currentCursor = clampToGraphemeBoundary(currentText, cursor());

      if (!key.ctrl && !key.meta && key.text !== undefined) {
        const clean = key.text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "");
        if (clean.length > 0) {
          const nextText =
            currentText.slice(0, currentCursor) + clean + currentText.slice(currentCursor);
          batch(() => {
            setText(nextText);
            setCursor(clampToGraphemeBoundary(nextText, currentCursor + clean.length));
          });
          return true;
        }
      }

      if (!key.ctrl && !key.meta && key.name === "backspace") {
        if (currentCursor > 0) {
          const prev = prevGraphemeBoundary(currentText, currentCursor);
          const nextText =
            currentText.slice(0, prev) + currentText.slice(currentCursor);
          batch(() => {
            setText(nextText);
            setCursor(clampToGraphemeBoundary(nextText, prev));
          });
        }
        return true;
      }

      if (!key.ctrl && !key.meta && key.name === "delete") {
        if (currentCursor < currentText.length) {
          const next = nextGraphemeBoundary(currentText, currentCursor);
          const nextText =
            currentText.slice(0, currentCursor) + currentText.slice(next);
          batch(() => {
            setText(nextText);
            setCursor(clampToGraphemeBoundary(nextText, currentCursor));
          });
        }
        return true;
      }

      if (!key.ctrl && !key.meta && key.name === "left") {
        if (currentCursor > 0) {
          setCursor(prevGraphemeBoundary(currentText, currentCursor));
        }
        return true;
      }

      if (!key.ctrl && !key.meta && key.name === "right") {
        if (currentCursor < currentText.length) {
          setCursor(nextGraphemeBoundary(currentText, currentCursor));
        }
        return true;
      }

      if ((!key.ctrl && !key.meta && key.name === "home") || (key.ctrl && !key.meta && key.name === "a")) {
        setCursor(0);
        return true;
      }

      if ((!key.ctrl && !key.meta && key.name === "end") || (key.ctrl && !key.meta && key.name === "e")) {
        setCursor(currentText.length);
        return true;
      }

      if (key.ctrl && !key.meta && key.name === "w") {
        if (currentCursor > 0) {
          const segments = segmentGraphemes(currentText.slice(0, currentCursor));
          let idx = segments.length;
          while (idx > 0 && /^\s+$/u.test(segments[idx - 1]!.segment)) {
            idx--;
          }
          while (idx > 0 && !/^\s+$/u.test(segments[idx - 1]!.segment)) {
            idx--;
          }
          const cutAt = idx < segments.length ? segments[idx]!.index : currentCursor;
          const nextText = currentText.slice(0, cutAt) + currentText.slice(currentCursor);
          batch(() => {
            setText(nextText);
            setCursor(clampToGraphemeBoundary(nextText, cutAt));
          });
        }
        return true;
      }

      if (key.ctrl && !key.meta && key.name === "u") {
        if (currentCursor > 0) {
          const nextText = currentText.slice(currentCursor);
          batch(() => {
            setText(nextText);
            setCursor(0);
          });
        }
        return true;
      }

      if (multiline && key.ctrl && !key.meta && key.name === "j") {
        const nextText =
          currentText.slice(0, currentCursor) + "\n" + currentText.slice(currentCursor);
        batch(() => {
          setText(nextText);
          setCursor(clampToGraphemeBoundary(nextText, currentCursor + 1));
        });
        return true;
      }

      return false;
    },
    paste(pasted: string): void {
      const normalized = (
        multiline
          ? pasted.replace(/\r\n|\r|\u2028|\u2029/g, "\n").replace(/\t+/g, " ")
          : pasted.replace(/[\t\r\n\u2028\u2029]+/g, " ")
      ).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
      if (normalized.length === 0) return;
      const currentText = text();
      const currentCursor = clampToGraphemeBoundary(currentText, cursor());
      const nextText =
        currentText.slice(0, currentCursor) + normalized + currentText.slice(currentCursor);
      batch(() => {
        setText(nextText);
        setCursor(clampToGraphemeBoundary(nextText, currentCursor + normalized.length));
      });
    },
  };
}


