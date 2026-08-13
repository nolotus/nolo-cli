import { longestTagPrefixLength } from "./tagPrefixMatch";

const DSML_OPEN = "<｜｜DSML｜｜tool_calls>";
const DSML_CLOSE = "</｜｜DSML｜｜tool_calls>";
const DSML_INVOKE_RE = /<｜｜DSML｜｜invoke\s+name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
const DSML_PARAMETER_RE = /<｜｜DSML｜｜parameter\s+([^>]+)>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;

export type DsmlToolCall = { name: string; arguments: string };
export type DsmlParserState = { mode: "content" | "dsml"; buffer: string };
export type DsmlChunk = { content: string; toolCalls: DsmlToolCall[] };

export function createDsmlParserState(): DsmlParserState {
  return { mode: "content", buffer: "" };
}

function parseAttributes(raw: string) {
  return {
    name: raw.match(/(?:^|\s)name="([^"]+)"/)?.[1],
    stringFlag: raw.match(/(?:^|\s)string="(true|false)"/)?.[1],
  };
}

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function parseValue(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function parseCalls(text: string): DsmlToolCall[] {
  const calls: DsmlToolCall[] = [];
  for (const match of text.matchAll(DSML_INVOKE_RE)) {
    const args: Record<string, unknown> = {};
    for (const parameter of match[2].matchAll(DSML_PARAMETER_RE)) {
      const attrs = parseAttributes(parameter[1]);
      if (!attrs.name) continue;
      const value = decode(parameter[2]);
      args[attrs.name] = attrs.stringFlag === "true" ? value : attrs.stringFlag === "false" ? parseValue(value) : value;
    }
    const name = match[1];
    if (name === "readFile" && args.path === undefined && args.file !== undefined) {
      args.path = args.file;
      delete args.file;
    }
    calls.push({ name, arguments: JSON.stringify(args) });
  }
  return calls;
}

export function pushDsmlChunk(chunk: string, state: DsmlParserState): DsmlChunk {
  state.buffer += chunk;
  let content = "";
  const toolCalls: DsmlToolCall[] = [];
  while (true) {
    if (state.mode === "content") {
      const index = state.buffer.indexOf(DSML_OPEN);
      if (index < 0) {
        const keep = longestTagPrefixLength(state.buffer, DSML_OPEN);
        content += state.buffer.slice(0, state.buffer.length - keep);
        state.buffer = state.buffer.slice(state.buffer.length - keep);
        break;
      }
      content += state.buffer.slice(0, index);
      state.buffer = state.buffer.slice(index + DSML_OPEN.length);
      state.mode = "dsml";
    } else {
      const index = state.buffer.indexOf(DSML_CLOSE);
      if (index < 0) break;
      toolCalls.push(...parseCalls(state.buffer.slice(0, index)));
      state.buffer = state.buffer.slice(index + DSML_CLOSE.length);
      state.mode = "content";
    }
  }
  return { content, toolCalls };
}

export function finishDsml(state: DsmlParserState): DsmlChunk {
  const result: DsmlChunk = { content: "", toolCalls: [] };
  if (state.mode === "dsml") result.toolCalls.push(...parseCalls(state.buffer));
  else result.content = state.buffer;
  state.mode = "content";
  state.buffer = "";
  return result;
}

export function parseDsml(text: string): DsmlChunk {
  const state = createDsmlParserState();
  const chunk = pushDsmlChunk(text, state);
  const tail = finishDsml(state);
  return { content: chunk.content + tail.content, toolCalls: [...chunk.toolCalls, ...tail.toolCalls] };
}
