import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

export type ThinkingDisplayMode = "hide" | "marker" | "show";

const THINK_OPEN = /<think>/i;
const THINK_CLOSE = /<\/think>/i;
const COLLAPSED_MARKER = /^\s*▸ 思考已折叠\s*$/;

export function normalizeThinkingDisplayMode(
  raw: string | undefined,
  fallback: ThinkingDisplayMode = "hide"
): ThinkingDisplayMode {
  const normalized = asTrimmedLowercaseString(raw);
  if (normalized === "hide" || normalized === "off" || normalized === "false" || normalized === "0") {
    return "hide";
  }
  if (normalized === "marker" || normalized === "collapsed" || normalized === "fold") {
    return "marker";
  }
  if (normalized === "show" || normalized === "on" || normalized === "true" || normalized === "1") {
    return "show";
  }
  return fallback;
}

export function resolveThinkingDisplayMode(env: Record<string, string | undefined> = process.env) {
  return normalizeThinkingDisplayMode(env.NOLO_CLI_THINKING ?? env.NOLO_THINKING, "hide");
}

export function collapseThinkingBlocks(text: string, mode: ThinkingDisplayMode = "hide") {
  if (mode === "show") return text;
  const replacement = mode === "marker" ? "▸ 思考已折叠\n" : "";
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, replacement)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripCollapsedThinkingMarkers(text: string) {
  return text
    .split("\n")
    .filter((line) => !COLLAPSED_MARKER.test(line))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function formatAssistantTextForCli(text: string, mode: ThinkingDisplayMode = "hide") {
  const collapsed = collapseThinkingBlocks(text, mode);
  return mode === "hide" ? stripCollapsedThinkingMarkers(collapsed) : collapsed;
}

export function createThinkingEventSink(
  write: (chunk: string) => void,
  mode?: ThinkingDisplayMode
): { push(chunk: string): void };
export function createThinkingEventSink(
  mode: ThinkingDisplayMode,
  write: (chunk: string) => void
): { push(chunk: string): void };
export function createThinkingEventSink(
  arg1: ThinkingDisplayMode | ((chunk: string) => void),
  arg2?: ((chunk: string) => void) | ThinkingDisplayMode
): { push(chunk: string): void } {
  let mode: ThinkingDisplayMode = "hide";
  let write: (chunk: string) => void = () => {};

  if (typeof arg1 === "function") {
    write = arg1;
    if (typeof arg2 === "string") {
      mode = arg2;
    }
  } else {
    mode = arg1;
    if (typeof arg2 === "function") {
      write = arg2;
    }
  }

  if (mode === "hide") {
    return {
      push(_chunk: string) {},
    };
  }

  if (mode === "show") {
    return {
      push(chunk: string) {
        if (chunk) write(chunk);
      },
    };
  }

  let markerEmitted = false;
  return {
    push(chunk: string) {
      if (!chunk || markerEmitted) return;
      write("\n▸ 思考已折叠\n");
      markerEmitted = true;
    },
  };
}

export function createThinkingAwareStreamFilter(
  write: (chunk: string) => void,
  mode: ThinkingDisplayMode = "hide"
) {
  if (mode === "show") {
    return {
      push(chunk: string) {
        write(chunk);
      },
      flush() {},
    };
  }

  let pending = "";
  let insideThink = false;
  let markerEmitted = false;

  const emit = (chunk: string) => {
    if (chunk) write(chunk);
  };

  const emitMarker = () => {
    if (mode !== "marker" || markerEmitted) return;
    emit("\n▸ 思考已折叠\n");
    markerEmitted = true;
  };

  const consume = (input: string) => {
    pending += input;
    while (pending.length > 0) {
      if (insideThink) {
        const closeMatch = pending.match(THINK_CLOSE);
        if (!closeMatch || closeMatch.index == null) {
          emitMarker();
          pending = "";
          return;
        }
        emitMarker();
        pending = pending.slice(closeMatch.index + closeMatch[0].length);
        insideThink = false;
        markerEmitted = false;
        continue;
      }

      const openMatch = pending.match(THINK_OPEN);
      if (!openMatch || openMatch.index == null) {
        const nextMarker = pending.indexOf("<");
        if (nextMarker === -1) {
          const cleaned = mode === "hide"
            ? pending.split("\n").filter((line) => !COLLAPSED_MARKER.test(line)).join("\n")
            : pending;
          emit(cleaned);
          pending = "";
          return;
        }
        if (nextMarker > 0) {
          const head = pending.slice(0, nextMarker);
          const cleaned = mode === "hide"
            ? head.split("\n").filter((line) => !COLLAPSED_MARKER.test(line)).join("\n")
            : head;
          emit(cleaned);
          pending = pending.slice(nextMarker);
          continue;
        }
        if (pending.length < 7) return;
        emit(pending[0]);
        pending = pending.slice(1);
        continue;
      }

      if (openMatch.index > 0) {
        const head = pending.slice(0, openMatch.index);
        const cleaned = mode === "hide"
          ? head.split("\n").filter((line) => !COLLAPSED_MARKER.test(line)).join("\n")
          : head;
        emit(cleaned);
        pending = pending.slice(openMatch.index);
        continue;
      }

      pending = pending.slice(openMatch[0].length);
      insideThink = true;
      markerEmitted = false;
    }
  };

  return {
    push(chunk: string) {
      consume(chunk);
    },
    flush() {
      if (insideThink) emitMarker();
      if (pending) {
        const cleaned = mode === "hide"
          ? pending.split("\n").filter((line) => !COLLAPSED_MARKER.test(line)).join("\n")
          : pending;
        emit(cleaned);
      }
      pending = "";
      insideThink = false;
      markerEmitted = false;
    },
  };
}