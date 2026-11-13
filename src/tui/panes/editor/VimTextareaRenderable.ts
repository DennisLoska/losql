import {
  type KeyEvent,
  type RenderContext,
  type TextareaOptions,
  TextareaRenderable,
} from "@opentui/core";
import { extend } from "@opentui/solid";

/** A textarea that never edits on its own: every key arrives through KeysApi and the vim engine. */
export class VimTextareaRenderable extends TextareaRenderable {
  constructor(ctx: RenderContext, options: TextareaOptions & { focused?: boolean }) {
    super(ctx, options);
  }

  override handleKeyPress(_key: KeyEvent): boolean {
    return false;
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    vim_textarea: typeof VimTextareaRenderable;
  }
}

extend({ vim_textarea: VimTextareaRenderable });
