/**
 * TUI 滚动条与滚动动作解析。
 *
 * renderScrollbarRow 是纯渲染函数（无依赖）；parseScrollAction 解析终端
 * 按键/鼠标序列为语义动作。applyScrollAction 操作 TurnHistory，放在
 * tuiHistory 以避免循环依赖——本文件只保留纯解析与渲染。
 */
export type ScrollAction =
  | "page-up"
  | "page-down"
  | "half-page-up"
  | "half-page-down"
  | "top"
  | "bottom"
  | "wheel-up"
  | "wheel-down";

/** SGR mouse report: ESC [ < button ; col ; row (M=press/wheel, m=release). */
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_REGEX = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

export function parseScrollAction(sequence: string): ScrollAction | null {
  const mouse = SGR_MOUSE_REGEX.exec(sequence);
  if (mouse) {
    const button = Number(mouse[1]);
    // Wheel events carry bit 6 (64): 64=up, 65=down, 66/67=horizontal.
    if ((button & 64) === 0) return null;
    if ((button & 2) !== 0) return null; // horizontal wheel: no mapping
    return (button & 1) !== 0 ? "wheel-down" : "wheel-up";
  }
  switch (sequence) {
    case "\x1b[5~":
      return "page-up";
    case "\x1b[6~":
      return "page-down";
    case "\x1b[5;2~":
    case "\x1b[5;5~":
      return "half-page-up";
    case "\x1b[6;2~":
    case "\x1b[6;5~":
      return "half-page-down";
    case "\x1b[H":
    case "\x1b[1~":
    case "\x1b[7~":
      return "top";
    case "\x1b[F":
    case "\x1b[4~":
    case "\x1b[8~":
      return "bottom";
    default:
      return null;
  }
}

export const WHEEL_SCROLL_LINES = 3;

/**
 * 渲染滚动条的单行缩略字符。totalLines <= visibleHeight 时返回空格（无滚动条）。
 */
export function renderScrollbarRow(
  rowIndex: number,
  visibleHeight: number,
  totalLines: number,
  scrollTop: number
): string {
  if (totalLines <= visibleHeight) return " ";
  const trackHeight = visibleHeight;
  const thumbSize = Math.max(
    1,
    Math.floor((visibleHeight * visibleHeight) / totalLines)
  );
  const maxScrollTop = totalLines - visibleHeight;
  const thumbTop = Math.floor(
    (scrollTop / maxScrollTop) * (trackHeight - thumbSize)
  );
  const thumbBottom = thumbTop + thumbSize;
  if (rowIndex >= thumbTop && rowIndex < thumbBottom) {
    return "█";
  }
  return "│";
}