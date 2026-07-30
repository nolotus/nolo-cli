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
export const SGR_MOUSE_REGEX = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

/**
 * Whether an SGR mouse sequence is a wheel event (bit 6 set, 64=up / 65=down;
 * 66/67 are horizontal). Non-wheel clicks/drags return false. Callers use
 * this to decide whether to keep a mouse sequence (wheel → scroll) or drop
 * it (click → ignore) so a stray click into the terminal doesn't get
 * misparsed as a key and accidentally cancel the dialog.
 */
export function isSgrWheelEvent(sequence: string): boolean {
  const mouse = SGR_MOUSE_REGEX.exec(sequence);
  if (!mouse) return false;
  const button = Number(mouse[1]);
  if ((button & 64) === 0) return false; // not a wheel event
  if ((button & 2) !== 0) return false; // horizontal wheel
  return true;
}

/**
 * Try to extract a complete SGR mouse report from `buffer`.
 * Returns the matched sequence string when `buffer` starts with a complete
 * `\x1b[<button;col;row M/m` report, otherwise `undefined` when the buffer
 * could still grow into one, or `null` when the buffer clearly isn't a
 * mouse report. Used by the raw key reader so mouse clicks (which arrive as
 * multi-byte CSI sequences) aren't dropped into the 8-byte escape bucket and
 * misread as a cancel.
 */
export function consumeSgrMouseSequence(
  buffer: string,
): string | null | undefined {
  if (!buffer.startsWith("\x1b[")) return null;
  // SGR mouse reports start with ESC [ < ; anything else is a non-mouse CSI.
  if (!buffer.startsWith("\x1b[<")) {
    // Could still be a different CSI we don't handle; let the caller's own
    // CSI logic decide. Return null to signal "not a mouse sequence".
    return null;
  }
  // The report ends with M (press/wheel) or m (release).
  const endIndex = buffer.search(/[Mm]/);
  if (endIndex === -1) return undefined; // incomplete, wait for more bytes
  const candidate = buffer.slice(0, endIndex + 1);
  if (SGR_MOUSE_REGEX.test(candidate)) return candidate;
  return null;
}

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