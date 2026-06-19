type CliTextStyle = "dim" | "bold" | "cyan" | "green" | "red";

const ANSI: Record<CliTextStyle, string> = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

const RESET = "\x1b[0m";

export function resolveCliColorEnabled(
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY)
) {
  const setting = (env.NOLO_CLI_COLOR ?? "").trim().toLowerCase();
  if (setting === "0" || setting === "false" || setting === "off") return false;
  if (env.NO_COLOR) return false;
  if (setting === "1" || setting === "true" || setting === "on") return true;
  return isTTY;
}

export function styleCliText(
  text: string,
  style: CliTextStyle,
  enabled = resolveCliColorEnabled()
) {
  if (!enabled || !text) return text;
  return `${ANSI[style]}${text}${RESET}`;
}

export function dimCliText(text: string, enabled = resolveCliColorEnabled()) {
  return styleCliText(text, "dim", enabled);
}

export function composeCliStyledText(
  parts: Array<{ text: string; style?: CliTextStyle }>,
  enabled = resolveCliColorEnabled()
) {
  if (!enabled) return parts.map((part) => part.text).join("");
  return parts
    .map((part) => (part.style ? styleCliText(part.text, part.style, true) : part.text))
    .join("");
}