import { themeColorSequence } from "../tui/theme";
import type { OutputLike } from "./agentRunTypes";

export function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

/**
 * Truncate a thinking hint to fit within a reasonable width on the spinner
 * line. Keeps the last `maxLen` characters of accumulated thinking so the
 * user sees what the model is currently reasoning about.
 */
function truncateThinkingHint(text: string, maxLen: number): string {
  const cleaned = text.replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return "…" + cleaned.slice(cleaned.length - maxLen + 1);
}

/**
 * 终端 spinner：在 agent turn 进行中作为唯一的"alive"指示器，
 * 取代静态光标，避免被误判为卡死。非 TTY 环境下降级为一次性文本输出。
 *
 * 支持显示实时 thinking 片段：当 thinking 内容到达时，spinner 行
 * 切换为显示最近一段思考内容，让用户看到模型正在想什么。
 */
export class Spinner {
  private timer: any = null;
  private startTime = 0;
  private frameIndex = 0;
  private frames = ["·", "~", "≈", "∿", "≈", "~"];
  private isTTY: boolean;
  private thinkingHint = "";

  constructor(
    private output: OutputLike,
    private text: string,
    private silent = false,
  ) {
    // Prefer the stream's own TTY flag. History capture streams set isTTY so
    // \r in-place updates are interpreted; falling back only when unset keeps
    // plain stdout/file mocks working.
    const explicit = (output as { isTTY?: boolean }).isTTY;
    this.isTTY =
      typeof explicit === "boolean" ? explicit : Boolean(process.stdout.isTTY);
  }

  start() {
    if (this.silent) {
      this.startTime = Date.now();
      return;
    }
    if (!this.isTTY) {
      this.output.write(`\n${this.text}\n`);
      return;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.frameIndex = 0;
    this.startTime = Date.now();
    // Preserve any thinking hint that arrived before the spinner started
    // (e.g. the first streaming chunk was a think block — setThinkingHint
    // caches it even when the timer isn't running yet).
    // Take over the cursor role: the spinner becomes the only "alive"
    // indicator while the agent turn is in flight, so a static terminal
    // cursor can no longer be mistaken for a frozen process.
    this.output.write("\x1b[?25l");
    this.output.write(this.renderLine(this.frames[0]));
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.output.write(`\r${this.renderLine(this.frames[this.frameIndex])}`);
    }, 80);
  }

  stop() {
    const wasActive = this.timer !== null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.silent) return;
    // Only clear the line when a spinner frame is actually on screen
    // (timer was running). Calling stop() when no spinner is active must
    // be a true no-op — otherwise \r would discard valid transcript content
    // on the current line (e.g. a just-written tool result or assistant text).
    if (this.isTTY && wasActive) {
      this.output.write("\r\x1b[K");
      this.output.write("\x1b[?25h");
    }
    this.thinkingHint = "";
  }

  show(text: string) {
    this.text = text;
    this.thinkingHint = "";
    if (this.silent) {
      if (!this.startTime) {
        this.startTime = Date.now();
      }
      return;
    }
    if (!this.isTTY) return;
    if (!this.timer) {
      this.start();
      return;
    }
    this.frameIndex = 0;
    this.startTime = Date.now();
    this.output.write(`\r${this.renderLine(this.frames[0])}`);
  }

  /**
   * Update the thinking hint displayed on the spinner line. The hint is
   * truncated to a reasonable length and shown as part of the spinner text.
   * Only meaningful while the spinner is active (TTY mode).
   */
  setThinkingHint(text: string) {
    this.thinkingHint = text;
    if (this.silent || !this.isTTY || !this.timer) return;
    this.output.write(`\r${this.renderLine(this.frames[this.frameIndex])}`);
  }

  private renderLine(frame: string): string {
    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - this.startTime) / 1000),
    );
    const thinkingPart = this.thinkingHint
      ? `: ${truncateThinkingHint(this.thinkingHint, 60)}`
      : "";
    return `${themeColorSequence("accent")}${frame}\x1b[39m ${this.text}${thinkingPart} (${formatElapsed(elapsedSeconds)})`;
  }
}