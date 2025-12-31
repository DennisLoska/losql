import {
  TextareaRenderable,
  type TextareaOptions,
  type KeyEvent,
  type PasteEvent,
  type CursorStyleOptions,
  type RenderContext,
} from "@opentui/core";

export type VimMode = "normal" | "insert";

export interface VimTextareaOptions extends TextareaOptions {
  onModeChange?: (mode: VimMode) => void;
}

export class VimTextareaRenderable extends TextareaRenderable {
  private _mode: VimMode = "normal";
  private _modeChangeListener?: (mode: VimMode) => void;
  private _pendingOperator: string | null = null; // For dd, yy, etc.

  // Cursor styles per mode
  private readonly _normalCursor: CursorStyleOptions = {
    style: "block",
    blinking: false,
  };
  private readonly _insertCursor: CursorStyleOptions = {
    style: "line",
    blinking: true,
  };

  constructor(ctx: RenderContext, options: VimTextareaOptions) {
    super(ctx, {
      ...options,
      cursorStyle: { style: "block", blinking: false }, // Start in normal mode
    });

    this._modeChangeListener = options.onModeChange;
    this.updateCursorForMode();
  }

  public get mode(): VimMode {
    return this._mode;
  }

  private setMode(mode: VimMode): void {
    if (this._mode === mode) return;

    this._mode = mode;
    this._pendingOperator = null; // Clear pending operator on mode change
    this.updateCursorForMode();

    if (this._modeChangeListener) {
      this._modeChangeListener(mode);
    }

    this.requestRender();
  }

  private updateCursorForMode(): void {
    const cursorStyle =
      this._mode === "normal" ? this._normalCursor : this._insertCursor;
    this.cursorStyle = cursorStyle;
  }

  public override focus(): void {
    super.focus();
    this.updateCursorForMode();
  }

  public override handlePaste(event: PasteEvent): void {
    if (this._mode === "insert") {
      super.handlePaste(event);
    }
    // In normal mode, ignore paste
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    switch (this._mode) {
      case "normal":
        return this.handleNormalMode(key);
      case "insert":
        return this.handleInsertMode(key);
      default:
        return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────

  private getLines(): string[] {
    return this.plainText.split("\n");
  }

  private getCurrentLineLength(): number {
    const lines = this.getLines();
    const cursor = this.logicalCursor;
    return lines[cursor.row]?.length ?? 0;
  }

  private isCurrentLineEmpty(): boolean {
    return this.getCurrentLineLength() === 0;
  }

  // ─────────────────────────────────────────────────────────────
  // NORMAL MODE
  // ─────────────────────────────────────────────────────────────

  private handleNormalMode(key: KeyEvent): boolean {
    // Don't process keys with meta/super modifiers (except Ctrl-r for redo)
    if (key.meta || key.super) {
      this._pendingOperator = null;
      return false;
    }

    // Undo: u
    if (key.name === "u" && !key.ctrl) {
      this._pendingOperator = null;
      this.undo();
      return true;
    }

    // Redo: Ctrl-r
    if (key.name === "r" && key.ctrl) {
      this._pendingOperator = null;
      this.redo();
      return true;
    }

    // Skip other ctrl combinations
    if (key.ctrl) {
      this._pendingOperator = null;
      return false;
    }

    // ─── Handle pending operator ───
    if (this._pendingOperator === "d") {
      if (key.name === "d") {
        // dd - delete line
        this.deleteLine();
        this._pendingOperator = null;
        return true;
      }
      // Any other key cancels the pending operator
      this._pendingOperator = null;
      // Fall through to process the key normally
    }

    if (this._pendingOperator === "g") {
      if (key.name === "g") {
        // gg - go to buffer start
        this.gotoBufferHome();
        this._pendingOperator = null;
        return true;
      }
      // Any other key cancels the pending operator
      this._pendingOperator = null;
      // Fall through to process the key normally
    }

    // ─── Mode switching ───
    if (key.name === "i" && !key.shift) {
      this.setMode("insert");
      return true;
    }

    if (key.name === "a" && !key.shift) {
      // Append after cursor - move right only if not on empty line
      if (!this.isCurrentLineEmpty()) {
        const cursor = this.logicalCursor;
        const lineLen = this.getCurrentLineLength();
        // Only move right if not already at end of line
        if (cursor.col < lineLen) {
          this.editBuffer.setCursor(cursor.row, cursor.col + 1);
        }
      }
      this.setMode("insert");
      return true;
    }

    if (key.name === "A" || (key.name === "a" && key.shift)) {
      // Go to end of line, then insert mode
      const cursor = this.logicalCursor;
      const lineLen = this.getCurrentLineLength();
      this.editBuffer.setCursor(cursor.row, lineLen);
      this.setMode("insert");
      return true;
    }

    if (key.name === "I" || (key.name === "i" && key.shift)) {
      // Go to first non-whitespace character of line, then insert mode
      const cursor = this.logicalCursor;
      const lines = this.getLines();
      const line = lines[cursor.row] ?? "";
      const firstNonWhitespace = line.search(/\S/);
      const col = firstNonWhitespace === -1 ? 0 : firstNonWhitespace;
      this.editBuffer.setCursor(cursor.row, col);
      this.setMode("insert");
      return true;
    }

    if (key.name === "o" && !key.shift) {
      // New line below, insert mode
      const cursor = this.logicalCursor;
      const lineLen = this.getCurrentLineLength();
      // Go to end of current line
      this.editBuffer.setCursor(cursor.row, lineLen);
      // Insert newline - cursor moves to new line
      this.newLine();
      this.setMode("insert");
      return true;
    }

    if (key.name === "O" || (key.name === "o" && key.shift)) {
      // New line above, insert mode
      const cursor = this.logicalCursor;
      const currentRow = cursor.row;
      // Go to start of current line
      this.editBuffer.setCursor(currentRow, 0);
      // Insert newline - this pushes current line down
      this.newLine();
      // Now cursor is on the new line (which has the old content pushed down)
      // We need to go back up to the empty line we created
      this.editBuffer.setCursor(currentRow, 0);
      this.setMode("insert");
      return true;
    }

    // ─── Basic motions ───
    if (key.name === "h" || key.name === "left") {
      this.moveCursorLeft();
      return true;
    }

    if (key.name === "j" || key.name === "down") {
      this.moveCursorDown();
      return true;
    }

    if (key.name === "k" || key.name === "up") {
      this.moveCursorUp();
      return true;
    }

    if (key.name === "l" || key.name === "right") {
      this.moveCursorRight();
      return true;
    }

    // ─── Line motions ───
    if (key.name === "0") {
      this.gotoLineHome();
      return true;
    }

    if (key.name === "$" || (key.name === "4" && key.shift)) {
      this.gotoLineEnd();
      return true;
    }

    // ─── Word motions ───
    if (key.name === "w" && !key.shift) {
      this.moveWordForward();
      return true;
    }

    if (key.name === "b" && !key.shift) {
      this.moveWordBackward();
      return true;
    }

    // ─── Document motions ───
    if (key.name === "g" && !key.shift) {
      // Start pending operator for gg
      this._pendingOperator = "g";
      return true;
    }

    if (key.name === "G" || (key.name === "g" && key.shift)) {
      // G - go to bottom
      this.gotoBufferEnd();
      return true;
    }

    // ─── Operators ───
    if (key.name === "x" && !key.shift) {
      // Delete character under cursor
      this.deleteChar();
      return true;
    }

    if (key.name === "d" && !key.shift) {
      // Start pending operator for dd
      this._pendingOperator = "d";
      return true;
    }

    if (key.name === "D" || (key.name === "d" && key.shift)) {
      // Delete to end of line
      this.deleteToLineEnd();
      return true;
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // INSERT MODE
  // ─────────────────────────────────────────────────────────────

  private handleInsertMode(key: KeyEvent): boolean {
    // Escape to normal mode
    if (key.name === "escape") {
      // Move cursor left when exiting insert mode (Vim behavior)
      // Only move left if not at column 0 to avoid jumping to previous line
      const cursor = this.logicalCursor;
      if (cursor.col > 0) {
        this.moveCursorLeft();
      }
      this.setMode("normal");
      return true;
    }

    // Delegate to parent's handleKeyPress for normal text editing
    return super.handleKeyPress(key);
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  public set onModeChange(handler: ((mode: VimMode) => void) | undefined) {
    this._modeChangeListener = handler;
  }

  public get onModeChange(): ((mode: VimMode) => void) | undefined {
    return this._modeChangeListener;
  }
}
