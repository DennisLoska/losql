import { extend } from "@opentui/solid";
import { VimTextareaRenderable, type VimMode } from "./VimTextareaRenderable";
import type { Component } from "solid-js";
import type { ColorInput } from "@opentui/core";

extend({ vim_textarea: VimTextareaRenderable });

export interface VimTextareaProps {
  initialValue?: string;
  focused?: boolean;
  cursorColor?: ColorInput;
  backgroundColor?: ColorInput;
  textColor?: ColorInput;
  focusedBackgroundColor?: ColorInput;
  focusedTextColor?: ColorInput;
  placeholder?: string;
  wrapMode?: "none" | "char" | "word";
  onModeChange?: (mode: VimMode) => void;
  onContentChange?: () => void;
  onCursorChange?: (event: { line: number; visualColumn: number }) => void;
  width?: number | string;
  height?: number | string;
  flexGrow?: number;
  flexShrink?: number;
}

export const VimTextarea: Component<VimTextareaProps> = (props) => {
  return (
    <vim_textarea
      focused={props.focused}
      initialValue={props.initialValue}
      cursorColor={props.cursorColor}
      backgroundColor={props.backgroundColor}
      textColor={props.textColor}
      focusedBackgroundColor={props.focusedBackgroundColor}
      focusedTextColor={props.focusedTextColor}
      placeholder={props.placeholder}
      wrapMode={props.wrapMode}
      onModeChange={props.onModeChange}
      onContentChange={props.onContentChange}
      onCursorChange={props.onCursorChange}
      width={props.width}
      height={props.height}
      flexGrow={props.flexGrow}
      flexShrink={props.flexShrink}
    />
  );
};

export { VimTextareaRenderable, type VimMode };
