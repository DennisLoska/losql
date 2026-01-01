import {
  TextareaRenderable,
  type TextareaOptions,
  type KeyEvent,
  type PasteEvent,
  type CursorStyleOptions,
  type RenderContext,
} from "@opentui/core";

export type VimMode = "normal" | "insert" | "visual" | "visual-line";

export interface YankRegister {
  text: string;
  isLinewise: boolean; // true if yanked with yy/Y/V, affects paste behavior
}

export interface VisualSelection {
  anchorRow: number;
  anchorCol: number;
}

export interface VimTextareaOptions extends TextareaOptions {
  onModeChange?: (mode: VimMode) => void;
  onBufferChange?: (content: string) => void;
  onKeyDown?: (key: KeyEvent) => void;
  onNormalModeKeyDown?: (key: KeyEvent) => void;
  value?: string; // Controlled value - updates buffer when changed
}

export class VimTextareaRenderable extends TextareaRenderable {
  private _mode: VimMode = "normal";
  private _modeChangeListener?: (mode: VimMode) => void;
  private _bufferChangeListener?: (content: string) => void;
  private _keyDownListener?: (key: KeyEvent) => void;
  private _normalModeKeyDownListener?: (key: KeyEvent) => void;
  private _pendingOperator: string | null = null; // For dd, yy, etc.
  private _yankRegister: YankRegister = { text: "", isLinewise: false };
  private _visualAnchor: VisualSelection | null = null;
  private _waitingForChar: string | null = null; // For r command
  private _lastExternalValue: string | undefined; // Track external value changes

  // Cursor styles per mode
  private readonly _normalCursor: CursorStyleOptions = {
    style: "block",
    blinking: false,
  };
  private readonly _insertCursor: CursorStyleOptions = {
    style: "line",
    blinking: true,
  };
  private readonly _visualCursor: CursorStyleOptions = {
    style: "block",
    blinking: false,
  };

  constructor(ctx: RenderContext, options: VimTextareaOptions) {
    super(ctx, {
      ...options,
      cursorStyle: { style: "block", blinking: false }, // Start in normal mode
    });

    this._modeChangeListener = options.onModeChange;
    this._bufferChangeListener = options.onBufferChange;
    this._keyDownListener = options.onKeyDown;
    this._normalModeKeyDownListener = options.onNormalModeKeyDown;
    this._lastExternalValue = options.value ?? options.initialValue;
    this.updateCursorForMode();
  }

  private notifyContentChange(): void {
    if (this._bufferChangeListener) {
      this._bufferChangeListener(this.plainText);
    }
  }

  public get mode(): VimMode {
    return this._mode;
  }

  private setMode(mode: VimMode): void {
    if (this._mode === mode) return;

    // Clear visual selection when leaving visual modes
    if (
      (this._mode === "visual" || this._mode === "visual-line") &&
      mode !== "visual" &&
      mode !== "visual-line"
    ) {
      this._visualAnchor = null;
      // Clear the text selection highlight
      this.clearVisualHighlight();
    }

    this._mode = mode;
    this._pendingOperator = null; // Clear pending operator on mode change
    this._waitingForChar = null; // Clear waiting state
    this.updateCursorForMode();

    if (this._modeChangeListener) {
      this._modeChangeListener(mode);
    }

    this.requestRender();
  }

  private updateCursorForMode(): void {
    let cursorStyle: CursorStyleOptions;
    switch (this._mode) {
      case "insert":
        cursorStyle = this._insertCursor;
        break;
      case "visual":
      case "visual-line":
        cursorStyle = this._visualCursor;
        break;
      default:
        cursorStyle = this._normalCursor;
    }
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
    if (this._keyDownListener) {
      this._keyDownListener(key);
    }

    // Handle waiting for character (r command)
    if (this._waitingForChar === "r") {
      return this.handleReplaceChar(key);
    }

    switch (this._mode) {
      case "normal":
        return this.handleNormalMode(key);
      case "insert":
        return this.handleInsertMode(key);
      case "visual":
      case "visual-line":
        return this.handleVisualMode(key);
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

  private getCurrentLine(): string {
    const lines = this.getLines();
    const cursor = this.logicalCursor;
    return lines[cursor.row] ?? "";
  }

  private getLineAt(row: number): string {
    const lines = this.getLines();
    return lines[row] ?? "";
  }

  // ─────────────────────────────────────────────────────────────
  // VISUAL MODE HELPERS
  // ─────────────────────────────────────────────────────────────

  private clearVisualHighlight(): void {
    this._ctx.clearSelection();
    this.requestRender();
  }

  private startVisualSelection(): void {
    // To start visual selection, we do a "null" movement - move right then left
    // This triggers the parent's selection mechanism properly
    this.moveCursorRight({ select: true });
    this.moveCursorLeft({ select: true });
  }

  private updateVisualHighlight(): void {
    // Visual highlighting is handled by the parent's selection mechanism
    // when we use movement methods with { select: true }
    // This method now just ensures render is requested
    this.requestRender();
  }

  // ─────────────────────────────────────────────────────────────
  // YANK/PASTE HELPERS
  // ─────────────────────────────────────────────────────────────

  private yankLine(): void {
    const line = this.getCurrentLine();
    this._yankRegister = { text: line, isLinewise: true };
  }

  private yankToEndOfLine(): void {
    const cursor = this.logicalCursor;
    const line = this.getCurrentLine();
    const text = line.substring(cursor.col);
    this._yankRegister = { text, isLinewise: false };
  }

  private yankVisualSelection(): void {
    const text = this.getSelectedText();
    const isLinewise = this._mode === "visual-line";
    this._yankRegister = { text, isLinewise };
  }

  private pasteAfter(): void {
    if (!this._yankRegister.text) return;

    const cursor = this.logicalCursor;

    if (this._yankRegister.isLinewise) {
      // Paste on new line below
      const lineLen = this.getCurrentLineLength();
      this.editBuffer.setCursor(cursor.row, lineLen);
      this.newLine();
      this.insertText(this._yankRegister.text);
      // Move to start of pasted content
      this.editBuffer.setCursor(cursor.row + 1, 0);
    } else {
      // Paste after cursor
      if (!this.isCurrentLineEmpty()) {
        this.editBuffer.setCursor(cursor.row, cursor.col + 1);
      }
      this.insertText(this._yankRegister.text);
    }
  }

  private pasteBefore(): void {
    if (!this._yankRegister.text) return;

    const cursor = this.logicalCursor;

    if (this._yankRegister.isLinewise) {
      // Paste on new line above
      this.editBuffer.setCursor(cursor.row, 0);
      this.newLine();
      this.editBuffer.setCursor(cursor.row, 0);
      this.insertText(this._yankRegister.text);
      // Move to start of pasted content
      this.editBuffer.setCursor(cursor.row, 0);
    } else {
      // Paste at cursor
      this.insertText(this._yankRegister.text);
    }
  }

  private deleteVisualSelection(): void {
    const selection = this.getSelection();
    if (!selection) return;

    // Get the start position for cursor placement after delete
    const startPos = this.editBuffer.offsetToPosition(selection.start);

    // Delete the selected range
    if (this._mode === "visual-line") {
      // For line-wise, we need to delete full lines
      const startLinePos = this.editBuffer.offsetToPosition(selection.start);
      const endLinePos = this.editBuffer.offsetToPosition(selection.end);
      if (startLinePos && endLinePos) {
        // Delete from start of first line to end of last line (including newline)
        const startOffset = this.editBuffer.positionToOffset(
          startLinePos.row,
          0,
        );
        const lines = this.getLines();
        const endLineLen = lines[endLinePos.row]?.length ?? 0;
        let endOffset = this.editBuffer.positionToOffset(
          endLinePos.row,
          endLineLen,
        );
        // Include the newline if not at end of buffer
        if (endLinePos.row < lines.length - 1) {
          endOffset += 1;
        }
        const startCoords = this.editBuffer.offsetToPosition(startOffset);
        const endCoords = this.editBuffer.offsetToPosition(endOffset);
        if (startCoords && endCoords) {
          this.editBuffer.deleteRange(
            startCoords.row,
            startCoords.col,
            endCoords.row,
            endCoords.col,
          );
        }
        this.editBuffer.setCursor(startLinePos.row, 0);
      }
    } else {
      // Character-wise delete
      const startCoords = this.editBuffer.offsetToPosition(selection.start);
      const endCoords = this.editBuffer.offsetToPosition(selection.end);
      if (startCoords && endCoords) {
        this.editBuffer.deleteRange(
          startCoords.row,
          startCoords.col,
          endCoords.row,
          endCoords.col,
        );
        this.editBuffer.setCursor(startCoords.row, startCoords.col);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // REPLACE CHAR HANDLER
  // ─────────────────────────────────────────────────────────────

  private handleReplaceChar(key: KeyEvent): boolean {
    this._waitingForChar = null;

    // Cancel on escape
    if (key.name === "escape") {
      return true;
    }

    // Get the character to replace with
    // Use key.char if available, otherwise use key.name for single chars
    const char = key.name?.length === 1 ? key.name : null;

    if (char && char.length === 1 && !key.ctrl && !key.meta) {
      const cursor = this.logicalCursor;
      const lineLen = this.getCurrentLineLength();

      if (cursor.col < lineLen) {
        // Delete current char and insert new one
        this.deleteChar();
        this.insertChar(char);
        // Move back to stay on the replaced char
        this.editBuffer.setCursor(cursor.row, cursor.col);
        this.notifyContentChange();
      }
      return true;
    }

    return true; // Consume the key even if we don't act on it
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

    if (this._normalModeKeyDownListener) {
      this._normalModeKeyDownListener(key);
    }

    // Undo: u
    if (key.name === "u" && !key.ctrl) {
      this._pendingOperator = null;
      this.undo();
      this.notifyContentChange();
      return true;
    }

    // Redo: Ctrl-r
    if (key.name === "r" && key.ctrl) {
      this._pendingOperator = null;
      this.redo();
      this.notifyContentChange();
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
        this.notifyContentChange();
        return true;
      }
      // Any other key cancels the pending operator
      this._pendingOperator = null;
      // Fall through to process the key normally
    }

    if (this._pendingOperator === "y") {
      if (key.name === "y") {
        // yy - yank line
        this.yankLine();
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
      this.notifyContentChange();
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
      this.notifyContentChange();
      return true;
    }

    // ─── Basic motions ───
    if (key.name === "h" || key.name === "left") {
      // Vim behavior: h stops at column 0, doesn't wrap to previous line
      const cursor = this.logicalCursor;
      if (cursor.col > 0) {
        this.moveCursorLeft();
      }
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
      // Vim behavior: l stops at end of line, doesn't wrap to next line
      const cursor = this.logicalCursor;
      const lineLen = this.getCurrentLineLength();
      if (cursor.col < lineLen - 1 || lineLen === 0) {
        this.moveCursorRight();
      }
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
      this.notifyContentChange();
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
      this.notifyContentChange();
      return true;
    }

    // ─── Yank operators ───
    if (key.name === "y" && !key.shift) {
      // Start pending operator for yy
      this._pendingOperator = "y";
      return true;
    }

    if (key.name === "Y" || (key.name === "y" && key.shift)) {
      // Y - yank to end of line (like D but for yank)
      this.yankToEndOfLine();
      return true;
    }

    // ─── Paste operators ───
    if (key.name === "p" && !key.shift) {
      // p - paste after cursor
      this.pasteAfter();
      this.notifyContentChange();
      return true;
    }

    if (key.name === "P" || (key.name === "p" && key.shift)) {
      // P - paste before cursor
      this.pasteBefore();
      this.notifyContentChange();
      return true;
    }

    // ─── Replace char ───
    if (key.name === "r" && !key.shift && !key.ctrl) {
      // r - wait for next char to replace current char
      this._waitingForChar = "r";
      return true;
    }

    // ─── Visual mode ───
    // Check for uppercase V first (visual line mode)
    const isUpperV =
      key.name === "V" ||
      (key as any).char === "V" ||
      (key.name === "v" && key.shift);
    const isLowerV =
      (key.name === "v" || (key as any).char === "v") && !isUpperV;

    if (isUpperV) {
      // V - enter visual line mode and select entire current line
      const cursor = this.logicalCursor;
      this._visualAnchor = { anchorRow: cursor.row, anchorCol: 0 };
      this.setMode("visual-line");
      // Move cursor to start of line directly (without clearing selection)
      this.editBuffer.setCursor(cursor.row, 0);
      // Now select to end of line
      this.gotoLineEnd({ select: true });
      return true;
    }

    if (isLowerV) {
      // v - enter visual mode
      const cursor = this.logicalCursor;
      this._visualAnchor = { anchorRow: cursor.row, anchorCol: cursor.col };
      this.setMode("visual");
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
    const result = super.handleKeyPress(key);
    if (result) {
      this.notifyContentChange();
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // VISUAL MODE
  // ─────────────────────────────────────────────────────────────

  private handleVisualMode(key: KeyEvent): boolean {
    // Don't process keys with meta/super modifiers
    if (key.meta || key.super) {
      return false;
    }

    // Escape to normal mode
    if (key.name === "escape") {
      this.setMode("normal");
      return true;
    }

    // Switch between visual modes
    const isUpperV = key.name === "V" || (key.name === "v" && key.shift);
    const isLowerV = key.name === "v" && !isUpperV;

    if (isUpperV) {
      if (this._mode === "visual-line") {
        // Already in visual-line mode, exit
        this.setMode("normal");
      } else {
        // Switch from visual to visual-line
        this.setMode("visual-line");
      }
      return true;
    }

    if (isLowerV) {
      if (this._mode === "visual") {
        // Already in visual mode, exit
        this.setMode("normal");
      } else {
        // Switch from visual-line to visual
        this.setMode("visual");
      }
      return true;
    }

    // ─── Motions (extend selection) ───
    if (key.name === "h" || key.name === "left") {
      // Vim behavior: h stops at column 0, doesn't wrap to previous line
      const cursor = this.logicalCursor;
      if (cursor.col > 0) {
        this.moveCursorLeft({ select: true });
      }
      return true;
    }

    if (key.name === "j" || key.name === "down") {
      this.moveCursorDown({ select: true });
      return true;
    }

    if (key.name === "k" || key.name === "up") {
      this.moveCursorUp({ select: true });
      return true;
    }

    if (key.name === "l" || key.name === "right") {
      // Vim behavior: l stops at end of line, doesn't wrap to next line
      const cursor = this.logicalCursor;
      const lineLen = this.getCurrentLineLength();
      if (cursor.col < lineLen) {
        this.moveCursorRight({ select: true });
      }
      return true;
    }

    if (key.name === "0") {
      this.gotoLineHome({ select: true });
      return true;
    }

    if (key.name === "$" || (key.name === "4" && key.shift)) {
      this.gotoLineEnd({ select: true });
      return true;
    }

    if (key.name === "w" && !key.shift) {
      this.moveWordForward({ select: true });
      return true;
    }

    if (key.name === "b" && !key.shift) {
      this.moveWordBackward({ select: true });
      return true;
    }

    if (key.name === "G" || (key.name === "g" && key.shift)) {
      this.gotoBufferEnd({ select: true });
      return true;
    }

    // gg in visual mode
    if (key.name === "g" && !key.shift) {
      this._pendingOperator = "g";
      return true;
    }

    // Handle pending g for gg
    if (this._pendingOperator === "g" && key.name === "g") {
      this.gotoBufferHome({ select: true });
      this._pendingOperator = null;
      return true;
    }

    // ─── Operators on selection ───
    if (key.name === "y" && !key.shift) {
      // Yank selection
      this.yankVisualSelection();
      this.setMode("normal");
      return true;
    }

    if (key.name === "d" && !key.shift) {
      // Delete selection (and yank it)
      this.yankVisualSelection();
      this.deleteVisualSelection();
      this.setMode("normal");
      this.notifyContentChange();
      return true;
    }

    if (key.name === "x" && !key.shift) {
      // Delete selection (same as d in visual mode)
      this.yankVisualSelection();
      this.deleteVisualSelection();
      this.setMode("normal");
      this.notifyContentChange();
      return true;
    }

    if (key.name === "c" && !key.shift) {
      // Change selection (delete and enter insert mode)
      this.yankVisualSelection();
      this.deleteVisualSelection();
      this.setMode("insert");
      this.notifyContentChange();
      return true;
    }

    return false;
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

  public set onBufferChange(handler: ((content: string) => void) | undefined) {
    this._bufferChangeListener = handler;
  }

  public get onBufferChange(): ((content: string) => void) | undefined {
    return this._bufferChangeListener;
  }

  public override set onKeyDown(
    handler: ((key: KeyEvent) => void) | undefined,
  ) {
    this._keyDownListener = handler;
  }

  public override get onKeyDown(): ((key: KeyEvent) => void) | undefined {
    return this._keyDownListener;
  }

  public set onNormalModeKeyDown(
    handler: ((key: KeyEvent) => void) | undefined,
  ) {
    this._normalModeKeyDownListener = handler;
  }

  public get onNormalModeKeyDown(): ((key: KeyEvent) => void) | undefined {
    return this._normalModeKeyDownListener;
  }

  // Setter for controlled value - updates buffer when value changes externally
  public set value(newValue: string | undefined) {
    if (newValue === undefined) return;

    // Only update if the value actually changed from the last external value
    // This prevents overwriting user edits when the signal updates from onBufferChange
    if (newValue !== this._lastExternalValue && newValue !== this.plainText) {
      this._lastExternalValue = newValue;
      this.replaceText(newValue);
      this.requestRender();
    }
  }

  public get value(): string | undefined {
    return this.plainText;
  }
}
