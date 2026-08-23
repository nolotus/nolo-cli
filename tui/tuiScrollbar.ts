/**
 * TUI 模态滚动动作与 SGR 鼠标序列解析。
 *
 * 用于 modal 选择器（如 AgentPicker、DialogPicker、AskChoiceDialog）的翻页与鼠标滚轮解析。
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
function parseSgrMouseButton(sequence: string): number | null {
  const mouse = SGR_MOUSE_REGEX.exec(sequence);
  return mouse ? Number(mouse[1]) : null;
}

export function isSgrWheelEvent(sequence: string): boolean {
  const button = parseSgrMouseButton(sequence);
  if (button === null) return false;
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
  // Validate the body incrementally so an unrelated M/m later in the buffer
  // cannot terminate a malformed mouse report prematurely.
  const body = buffer.slice(3);
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "M" || character === "m") {
      if (index !== body.length - 1) return null;
      return SGR_MOUSE_REGEX.test(buffer) ? buffer : null;
    }
    if ((character < "0" || character > "9") && character !== ";") {
      return null;
    }
  }
  return undefined;
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
