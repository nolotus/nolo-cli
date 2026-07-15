import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

type CliTextStyle = "dim" | "bold" | "cyan" | "green" | "red" | "yellow" | "magenta" | "white" | "black";
type CliBgStyle = "bgCyan" | "bgGray" | "bgMagenta" | "bgYellow" | "bgBlue" | "bgGreen" | "bgRed" | "bgWhite";

const ANSI_FG: Record<CliTextStyle, string> = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  black: "\x1b[30m",
};

const ANSI_BG: Record<CliBgStyle, string> = {
  bgCyan: "\x1b[46m",
  bgGray: "\x1b[100m",
  bgMagenta: "\x1b[45m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgWhite: "\x1b[47m",
};

const RESET = "\x1b[0m";

export function resolveCliColorEnabled(
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY)
) {
  const setting = asTrimmedLowercaseString(env.NOLO_CLI_COLOR);
  if (setting === "0" || setting === "false" || setting === "off") return false;
  if (env.NO_COLOR) return false;
  if (setting === "1" || setting === "true" || setting === "on") return true;
  return isTTY;
}

export function styleCliText(
  text: string,
  style: CliTextStyle | CliBgStyle,
  enabled = resolveCliColorEnabled()
) {
  if (!enabled || !text) return text;
  const code = ANSI_FG[style as CliTextStyle] ?? ANSI_BG[style as CliBgStyle];
  return `${code}${text}${RESET}`;
}

export function dimCliText(text: string, enabled = resolveCliColorEnabled()) {
  return styleCliText(text, "dim", enabled);
}

export function styleCliSegment(
  text: string,
  options: { fg?: CliTextStyle; bg?: CliBgStyle },
  enabled = resolveCliColorEnabled()
) {
  if (!enabled || !text) return text;
  const codes: string[] = [];
  if (options.fg) codes.push(ANSI_FG[options.fg]);
  if (options.bg) codes.push(ANSI_BG[options.bg]);
  if (codes.length === 0) return text;
  return `${codes.join("")}${text}${RESET}`;
}

export function composeCliStyledText(
  parts: Array<{ text: string; style?: CliTextStyle | CliBgStyle }>,
  enabled = resolveCliColorEnabled()
) {
  if (!enabled) return parts.map((part) => part.text).join("");
  return parts
    .map((part) => (part.style ? styleCliText(part.text, part.style, true) : part.text))
    .join("");
}