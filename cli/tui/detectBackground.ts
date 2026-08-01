import { ReadStream } from "node:tty";
import type { TuiBrightness } from "./theme";

/**
 * Terminal background detection via OSC 11.
 *
 * Why this exists: brightness used to be guessed from COLORFGBG, which almost
 * no terminal emits, so resolution fell through to a hardcoded "dark" default.
 * On a light terminal that painted the dark palette's pastels (#89B4FA,
 * #F9E2AF) onto white — legible but visibly washed out.
 *
 * OSC 11 asks the terminal for its actual background color. iTerm2, Ghostty,
 * WezTerm, Kitty, Alacritty, Apple Terminal and modern xterm all answer it.
 * Terminals that don't simply stay silent, so the probe is bounded by a short
 * timeout and the caller keeps whatever default it had.
 */

/** Query: OSC 11 ; ? BEL — "what is your background color?" */
const OSC11_QUERY = "\x1b]11;?\x07";

/**
 * Reply shape: `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` terminated by BEL or ST (ESC \).
 * Components are hex of 1–4 digits; 4-digit (16-bit per channel) is the common
 * case, but Apple Terminal replies with fewer, so widths are normalized.
 */
const OSC11_REPLY_RE = /\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i;

/** Scale a variable-width hex component to 0–255. */
function componentToByte(raw: string): number {
  const value = Number.parseInt(raw, 16);
  const max = 16 ** raw.length - 1;
  return max === 0 ? 0 : Math.round((value / max) * 255);
}

/**
 * Perceived brightness (ITU-R BT.601 luma). The 0.5 cut is deliberately at the
 * midpoint: terminals in the ambiguous middle (solarized-style backgrounds) are
 * rare, and either palette stays readable there.
 */
export function brightnessFromRgb(r: number, g: number, b: number): TuiBrightness {
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma >= 0.5 ? "light" : "dark";
}

/** Parse an OSC 11 reply into a brightness, or null if it isn't one. */
export function parseOsc11Reply(reply: string): TuiBrightness | null {
  const match = reply.match(OSC11_REPLY_RE);
  if (!match) return null;
  return brightnessFromRgb(
    componentToByte(match[1]),
    componentToByte(match[2]),
    componentToByte(match[3])
  );
}

/**
 * Parse an OSC 11 reply into brightness + the terminal's exact background RGB
 * (6-digit uppercase hex, no "#"), or null if it isn't one.
 */
export function parseOsc11Background(reply: string): { brightness: TuiBrightness; hex: string } | null {
  const match = reply.match(OSC11_REPLY_RE);
  if (!match) return null;
  const channels = [
    componentToByte(match[1]),
    componentToByte(match[2]),
    componentToByte(match[3]),
  ];
  return {
    brightness: brightnessFromRgb(channels[0], channels[1], channels[2]),
    hex: channels
      .map((v) => v.toString(16).padStart(2, "0").toUpperCase())
      .join(""),
  };
}

type Stdin = NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };

/**
 * Is this an actual terminal device, as opposed to something merely wearing
 * `isTTY = true`?
 *
 * This distinction matters because the probe has to borrow stdin: it resumes
 * the stream and attaches a data listener. On a real tty.ReadStream that is
 * safe — the device buffers, and the TUI's reader picks up where we left off.
 * On a plain duplex stream (a PassThrough test double, a piped stream) resuming
 * puts it in flowing mode and any bytes that arrive during the probe window are
 * consumed and discarded, so whatever attaches next silently receives nothing.
 */
function isTerminalDevice(stream: unknown): boolean {
  return stream instanceof ReadStream;
}

export type DetectTerminalBackgroundArgs = {
  stdin?: Stdin;
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
  timeoutMs?: number;
  /** Override the terminal-device check. Tests use this to drive a fake pair. */
  isTerminal?: (stream: unknown) => boolean;
};

export type DetectedTerminalBackground = {
  brightness: TuiBrightness;
  hex: string;
};

/**
 * Probe the terminal for its background color.
 *
 * Resolves null when the terminal is not a TTY, does not answer in time, or
 * answers with something unparseable — callers treat null as "keep the current
 * default" rather than guessing.
 */
export async function detectTerminalBackground(
  args: DetectTerminalBackgroundArgs = {},
): Promise<DetectedTerminalBackground | null> {
  const stdin = (args.stdin ?? process.stdin) as Stdin;
  const stdout = args.stdout ?? process.stdout;
  const timeoutMs = args.timeoutMs ?? 100;
  const isTerminal = args.isTerminal ?? isTerminalDevice;

  if (!stdout || !(stdout as { isTTY?: boolean }).isTTY) return null;
  if (!stdin || !(stdin as { isTTY?: boolean }).isTTY) return null;
  if (typeof stdin.setRawMode !== "function") return null;
  if (!isTerminal(stdin)) return null;

  const wasRaw = Boolean((stdin as { isRaw?: boolean }).isRaw);

  return await new Promise<DetectedTerminalBackground | null>((resolve) => {
    let buffer = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: DetectedTerminalBackground | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdin.off("data", onData);
      // Restore raw mode to exactly what the caller had. The TUI sets raw mode
      // itself later; leaving the terminal flipped would swallow first keys.
      //
      // Deliberately no pause() here. Pausing looks like the mirror of the
      // resume() below, but the probe does not own the stream's flowing state:
      // the TUI attaches its own reader immediately after, and pausing stopped
      // input from ever reaching it — every raw-TTY test hung until timeout.
      try {
        if (!wasRaw) stdin.setRawMode?.(false);
      } catch {
        // A closed or non-TTY stdin cannot be restored — nothing to do.
      }
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString("latin1");
      const parsed = parseOsc11Background(buffer);
      if (parsed) finish(parsed);
      // Guard against a terminal streaming unrelated input at us forever.
      else if (buffer.length > 256) finish(null);
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.write(OSC11_QUERY);
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * Probe the terminal for its background brightness.
 *
 * Thin wrapper over detectTerminalBackground returning only the brightness,
 * kept for callers that just need light/dark (existing tests depend on it).
 */
export async function detectTerminalBrightness(
  args: DetectTerminalBackgroundArgs = {},
): Promise<TuiBrightness | null> {
  const r = await detectTerminalBackground(args);
  return r ? r.brightness : null;
}
