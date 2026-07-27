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
 * 终端 spinner：在 agent turn 进行中作为唯一的"alive"指示器，
 * 取代静态光标，避免被误判为卡死。非 TTY 环境下降级为一次性文本输出。
 */
export class Spinner {
  private timer: any = null;
  private startTime = 0;
  private frameIndex = 0;
  private frames = ["·", "~", "≈", "∿", "≈", "~"];
  private isTTY: boolean;

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
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.silent) return;
    if (this.isTTY) {
      this.output.write("\r\x1b[K");
      this.output.write("\x1b[?25h");
    }
  }

  show(text: string) {
    this.text = text;
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

  private renderLine(frame: string): string {
    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - this.startTime) / 1000),
    );
    return `${themeColorSequence("accent")}${frame}\x1b[39m ${this.text} (${formatElapsed(elapsedSeconds)})`;
  }
}