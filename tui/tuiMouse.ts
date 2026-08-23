/**
 * TUI 鼠标协议解析（SGR 1006 / DECSET 1002）。
 *
 * 将终端原始 SGR 鼠标序列转换为结构化的 TuiMouseEvent 语义事件。
 */

export type TuiMouseButton = "left" | "middle" | "right" | "none";

export type TuiMouseEventKind = "press" | "release" | "drag" | "wheel";

export type TuiMouseEvent = {
  kind: TuiMouseEventKind;
  button: TuiMouseButton;
  /** 1-based terminal column */
  x: number;
  /** 1-based terminal row */
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  wheelDirection?: "up" | "down";
};

/** SGR mouse report: ESC [ < button ; col ; row (M=press/drag/wheel, m=release). */
// eslint-disable-next-line no-control-regex
export const SGR_MOUSE_REGEX = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * 尝试从输入缓冲区中提取完整的 SGR 鼠标序列。
 * - 匹配成功返回完整的序列字符串
 * - 缓冲区尚未完整但前缀符合时返回 undefined
 * - 确定不是鼠标序列时返回 null
 */
export function consumeSgrMouseSequence(
  buffer: string,
): string | null | undefined {
  if (!buffer.startsWith("\x1b[")) return null;
  if (!buffer.startsWith("\x1b[<")) return null;

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

/**
 * 解析 SGR 鼠标序列为语义化的 TuiMouseEvent。
 */
export function parseSgrMouseEvent(sequence: string): TuiMouseEvent | null {
  const match = SGR_MOUSE_REGEX.exec(sequence);
  if (!match) return null;

  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const isRelease = match[4] === "m";

  const shift = (code & 4) !== 0;
  const alt = (code & 8) !== 0;
  const ctrl = (code & 16) !== 0;

  // Wheel events (bit 6 = 64)
  if ((code & 64) !== 0) {
    if ((code & 2) !== 0) {
      // Horizontal wheel: 暂不映射
      return null;
    }
    const wheelDirection = (code & 1) !== 0 ? "down" : "up";
    return {
      kind: "wheel",
      button: "none",
      x,
      y,
      shift,
      alt,
      ctrl,
      wheelDirection,
    };
  }

  const rawButton = code & 3;
  let button: TuiMouseButton = "none";
  if (rawButton === 0) button = "left";
  else if (rawButton === 1) button = "middle";
  else if (rawButton === 2) button = "right";

  if (isRelease) {
    return {
      kind: "release",
      button,
      x,
      y,
      shift,
      alt,
      ctrl,
    };
  }

  // Motion with button held (bit 5 = 32)
  if ((code & 32) !== 0) {
    return {
      kind: "drag",
      button,
      x,
      y,
      shift,
      alt,
      ctrl,
    };
  }

  return {
    kind: "press",
    button,
    x,
    y,
    shift,
    alt,
    ctrl,
  };
}
