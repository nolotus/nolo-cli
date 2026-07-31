/**
 * Cursor provider — native HTTP/2 ConnectRPC client for Cursor's AgentService.
 *
 * Ported from oh-my-pi's `cursor.ts` (streamCursor), trimmed to the chat
 * completions path only (no agent tool calls / exec / kv / mcp channel).
 *
 * Wire: ConnectRPC over HTTP/2, content-type application/connect+proto.
 * Endpoint: https://api2.cursor.sh/agent.v1.AgentService/Run
 * Auth: OAuth access token from the nolo cursor OAuth flow (apiKeyRef "cursor").
 *
 * The provider adapts nolo's `AgentRuntimeChatMessage[]` ↔ Cursor's
 * `AgentRunRequest` protobuf, streams `AgentServerMessage` frames, and emits
 * text/thinking deltas via the `AgentRuntimeProvider.complete` contract.
 */

import { createHash, randomUUID } from "node:crypto";
import http2 from "node:http2";

import { create, fromBinary, toBinary, toJson, fromJson } from "@bufbuild/protobuf";
import type { JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";

import type { AgentRuntimeAgentConfig } from "../hostAdapter";
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeOutputBlock,
  AgentRuntimeResult,
  AgentRuntimeToolCall,
} from "../types";
import type {
  AgentRuntimeCompleteOptions,
  AgentRuntimeProvider,
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "../hostAdapter";

import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  AssistantMessageSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  ExecClientMessageSchema,
  ModelDetailsSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  RequestedModelSchema,
  ResumeActionSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  ShellResultSchema,
  ReadResultSchema,
  ReadErrorSchema,
  GrepResultSchema,
  GrepErrorSchema,
  LsResultSchema,
  LsErrorSchema,
  DeleteResultSchema,
  DeleteErrorSchema,
  McpToolDefinitionSchema,
  McpArgsSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpErrorSchema,
  McpToolNotFoundSchema,
  McpTextContentSchema,
  McpToolResultContentItemSchema,
  ReadSuccessSchema,
  ReadRejectedSchema,
  ReadFileNotFoundSchema,
  ShellSuccessSchema,
  ShellFailureSchema,
  ShellRejectedSchema,
  BackgroundShellSpawnResultSchema,
  WriteResultSchema,
  WriteSuccessSchema,
  WriteErrorSchema,
  WriteRejectedSchema,
  DeleteSuccessSchema,
  DeleteRejectedSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  GrepContentResultSchema,
  GrepFilesResultSchema,
  GrepCountResultSchema,
  GrepFileCountSchema,
  GrepFileMatchSchema,
  GrepContentMatchSchema,
  LsSuccessSchema,
  LsDirectoryTreeNodeSchema,
  LsDirectoryTreeNode_FileSchema,
  LsRejectedSchema,
} from "./agent_pb";
import type {
  McpToolDefinition,
  AgentServerMessage,
  ReadResult,
  ShellResult,
  WriteResult,
  DeleteResult,
  GrepResult,
  LsResult,
  McpResult,
  GrepUnionResult,
  LsDirectoryTreeNode,
  LsDirectoryTreeNode_File,
} from "./agent_pb";
import { summarizeToolArguments } from "../summarizeToolArguments";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CURSOR_API_URL = "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";
const CURSOR_REQUEST_PATH = "/agent.v1.AgentService/Run";
const CONNECT_END_STREAM_FLAG = 0b00000010;
const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Map nolo catalog / legacy agent model ids onto Cursor GetUsableModels
 * wire ids. Cursor Pro bills first-party models (Grok 4.5 / Composer 2.5)
 * from the "Cursor Models" pool and third-party models from "Other Models".
 * Sending an unknown id (e.g. bare `cursor-grok-4.5`) does not hit the
 * first-party pool — Cursor falls through and burns Other Models instead.
 *
 * Source of truth: `POST /agent.v1.AgentService/GetUsableModels` for the
 * authenticated account (verified 2026-07-31).
 */
const CURSOR_WIRE_MODEL_ALIASES: Record<string, string> = {
  // First-party — Cursor Models pool
  "cursor-grok-4.5": "cursor-grok-4.5-high",
  "cursor-grok-4.5-fast": "cursor-grok-4.5-high-fast",
  "grok-4.5": "cursor-grok-4.5-high",
  "grok-4.5-fast": "cursor-grok-4.5-high-fast",
  "cursor-composer-2.5": "composer-2.5-fast",
  "composer-2.5": "composer-2.5",
  // Third-party convenience aliases we previously published in the registry
  "cursor-claude-4.6-sonnet": "claude-4.6-sonnet-medium",
  "cursor-claude-4.6-opus": "claude-4.6-opus-high",
  "cursor-gemini-3.1-pro": "gemini-3.1-pro",
};

/** Resolve a nolo/legacy model id to the wire id Cursor's AgentService accepts. */
export function resolveCursorWireModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  return CURSOR_WIRE_MODEL_ALIASES[trimmed] ?? trimmed;
}

// ---------------------------------------------------------------------------
// Blob store — Cursor resolves `bytes` fields as sha256(blob) IDs into a
// side-channel KV store the client serves via KvClientMessage getBlob/setBlob.
// For the chat-only path we keep an in-memory store and handle getBlob/setBlob
// inline so the server can resolve system prompt / history blobs.
// ---------------------------------------------------------------------------

function createBlobId(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function storeCursorBlob(
  blobStore: Map<string, Uint8Array>,
  data: Uint8Array,
): Uint8Array {
  const blobId = createBlobId(data);
  blobStore.set(Buffer.from(blobId).toString("hex"), data);
  return blobId;
}

// ---------------------------------------------------------------------------
// ConnectRPC framing
// ---------------------------------------------------------------------------

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error) {
      const code = typeof error.code === "string" ? error.code : "unknown";
      const message =
        typeof error.message === "string" ? error.message : "Unknown error";
      return new Error(`Cursor Connect error ${code}: ${message}`);
    }
    return null;
  } catch {
    return new Error("Failed to parse Cursor Connect end stream");
  }
}

// ---------------------------------------------------------------------------
// Message helpers (text-only path)
// ---------------------------------------------------------------------------

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image"; image: string; mediaType: string };
type CursorRootPromptContentPart = TextPart | ImagePart;

function extractTextFromContent(
  content: AgentRuntimeChatMessage["content"],
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any): c is TextPart => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function hasImagesInContent(
  content: AgentRuntimeChatMessage["content"],
): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((c: any) => c?.type === "image_url");
}

function buildCursorRootPromptContent(
  content: AgentRuntimeChatMessage["content"],
): CursorRootPromptContentPart[] {
  if (content == null) return [];
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: CursorRootPromptContentPart[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as any;
    if (part.type === "text" && typeof part.text === "string") {
      const text = part.text.trim();
      if (text) parts.push({ type: "text", text });
    } else if (part.type === "image_url" && part.image_url?.url) {
      const url: string = part.image_url.url;
      const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
      if (match) {
        parts.push({
          type: "image",
          image: match[2],
          mediaType: match[1],
        });
      }
    }
  }
  return parts;
}

function cursorUserContentKey(
  content: AgentRuntimeChatMessage["content"],
): string {
  if (typeof content === "string") return content.trim();
  const hash = createHash("sha256");
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const part = item as any;
      hash.update(part.type ?? "");
      if (part.type === "text") hash.update(part.text ?? "");
      else if (part.type === "image_url") {
        hash.update(part.image_url?.url ?? "");
      }
    }
  }
  return hash.digest("hex");
}

/** Index of the last user/developer message; -1 if none. */
function findLastUserMessageIndex(messages: AgentRuntimeChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function extractUserMessageText(msg: AgentRuntimeChatMessage): string {
  if (msg.role !== "user") return "";
  return extractTextFromContent(msg.content).trim();
}

function hasUserMessageImages(msg: AgentRuntimeChatMessage): boolean {
  return msg.role === "user" && hasImagesInContent(msg.content);
}

function extractAssistantMessageText(msg: AgentRuntimeChatMessage): string {
  if (msg.role !== "assistant") return "";
  return extractTextFromContent(msg.content).trim();
}

// ---------------------------------------------------------------------------
// System prompt + history → rootPromptMessagesJson blob IDs
// ---------------------------------------------------------------------------

function buildCursorSystemPromptJsons(
  systemPrompt: readonly string[] | undefined,
): string[] {
  const prompts = (systemPrompt ?? [])
    .map((s) => (typeof s === "string" ? s.toWellFormed() : ""))
    .filter((s) => s.trim().length > 0);
  if (prompts.length === 0) {
    return [
      JSON.stringify({ role: "system", content: "You are a helpful assistant." }),
    ];
  }
  return prompts.map((content) => JSON.stringify({ role: "system", content }));
}

function buildRootPromptMessagesJson(
  messages: AgentRuntimeChatMessage[],
  systemPromptIds: Uint8Array[],
  blobStore: Map<string, Uint8Array>,
  activeUserMessageIndex: number,
): Uint8Array[] {
  const entries: Uint8Array[] = [...systemPromptIds];
  const pushJson = (obj: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    entries.push(storeCursorBlob(blobStore, bytes));
  };

  for (let i = 0; i < messages.length; i++) {
    if (i === activeUserMessageIndex) break;
    const msg = messages[i];
    if (msg.role === "user") {
      const content = buildCursorRootPromptContent(msg.content);
      if (content.length === 0) continue;
      pushJson({ role: "user", content });
    } else if (msg.role === "assistant") {
      const text = extractAssistantMessageText(msg);
      if (!text) continue;
      pushJson({ role: "assistant", content: [{ type: "text", text }] });
    } else if (msg.role === "tool") {
      const text = extractTextFromContent(msg.content);
      if (!text) continue;
      pushJson({
        role: "user",
        content: [{ type: "text", text: `[Tool Result]\n${text}` }],
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Conversation turns (display metadata — rootPromptMessagesJson drives the
// actual model prompt, but turns[] is required by the server schema).
// ---------------------------------------------------------------------------

function buildConversationTurns(
  messages: AgentRuntimeChatMessage[],
  blobStore: Map<string, Uint8Array>,
  activeUserMessageIndex: number,
): Uint8Array[] {
  const turns: Uint8Array[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role !== "user") {
      i++;
      continue;
    }
    if (i === activeUserMessageIndex) break;

    const userText = extractUserMessageText(msg);
    if (userText.length === 0 && !hasUserMessageImages(msg)) {
      i++;
      continue;
    }

    const userMessage = createCursorUserMessage(
      msg.content,
      userText,
      deterministicUuid(`u:${turns.length}:${cursorUserContentKey(msg.content)}`),
    );
    const userMessageBytes = toBinary(UserMessageSchema, userMessage);
    const userMessageBlobId = storeCursorBlob(blobStore, userMessageBytes);

    const stepBlobIds: Uint8Array[] = [];
    i++;
    while (i < messages.length && messages[i].role !== "user") {
      const stepMsg = messages[i];
      if (stepMsg.role === "assistant") {
        const text = extractAssistantMessageText(stepMsg);
        if (text) {
          const step = create(ConversationStepSchema, {
            message: {
              case: "assistantMessage",
              value: create(AssistantMessageSchema, { text }),
            },
          });
          stepBlobIds.push(
            storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)),
          );
        }
      } else if (stepMsg.role === "tool") {
        const text = extractTextFromContent(stepMsg.content);
        if (text) {
          const step = create(ConversationStepSchema, {
            message: {
              case: "assistantMessage",
              value: create(AssistantMessageSchema, {
                text: `[Tool Result]\n${text}`,
              }),
            },
          });
          stepBlobIds.push(
            storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)),
          );
        }
      }
      i++;
    }

    const agentTurn = create(AgentConversationTurnStructureSchema, {
      userMessage: userMessageBlobId,
      steps: stepBlobIds,
    });
    const turn = create(ConversationTurnStructureSchema, {
      turn: {
        case: "agentConversationTurn",
        value: agentTurn,
      },
    });
    turns.push(
      storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)),
    );
  }
  return turns;
}

function deterministicUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  // Format as RFC4122 v4-ish deterministic UUID.
  const hex = hash.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function createCursorUserMessage(
  content: AgentRuntimeChatMessage["content"],
  text: string,
  messageId: string = randomUUID(),
) {
  const images = extractImages(content);
  return create(UserMessageSchema, {
    text,
    messageId,
    ...(images.length > 0
      ? {
          selectedContext: create(SelectedContextSchema, {
            selectedImages: images,
          }),
        }
      : {}),
  });
}

function extractImages(content: AgentRuntimeChatMessage["content"]) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item: any) => item?.type === "image_url" && item.image_url?.url)
    .map((item: any) => {
      const url: string = item.image_url.url;
      const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
      if (!match) return null;
      return create(SelectedImageSchema, {
        uuid: randomUUID(),
        mimeType: match[1],
        dataOrBlobId: {
          case: "data",
          value: Uint8Array.from(Buffer.from(match[2], "base64")),
        },
      });
    })
    .filter((x: any) => x !== null);
}

// ---------------------------------------------------------------------------
// buildGrpcRequest — assembles AgentRunRequest inside AgentClientMessage
// ---------------------------------------------------------------------------

export function buildCursorRunRequestBytes(args: {
  model: string;
  systemPrompt?: string;
  messages: AgentRuntimeChatMessage[];
  conversationId?: string;
  blobStore?: Map<string, Uint8Array>;
}): { requestBytes: Uint8Array; blobStore: Map<string, Uint8Array> } {
  const blobStore = args.blobStore ?? new Map<string, Uint8Array>();
  const conversationId = args.conversationId ?? randomUUID();

  const systemPromptIds = buildCursorSystemPromptJsons(
    args.systemPrompt ? [args.systemPrompt] : undefined,
  ).map((json) =>
    storeCursorBlob(blobStore, new TextEncoder().encode(json)),
  );

  const messages = args.messages;
  const activeUserMessageIndex = messages.length - 1;
  const activeMessage = messages[activeUserMessageIndex];
  const activeUserMessage =
    activeMessage?.role === "user" ? activeMessage : undefined;

  let userContent: AgentRuntimeChatMessage["content"] | undefined;
  let userText = "";
  let hasUserImages = false;
  if (activeUserMessage?.role === "user") {
    userContent = activeUserMessage.content;
    userText = extractTextFromContent(userContent).trim();
    hasUserImages = hasImagesInContent(userContent);
  }

  const action = create(ConversationActionSchema, {
    action:
      userContent && (userText.length > 0 || hasUserImages)
        ? {
            case: "userMessageAction",
            value: create(UserMessageActionSchema, {
              userMessage: createCursorUserMessage(userContent, userText),
            }),
          }
        : {
            case: "resumeAction",
            value: create(ResumeActionSchema, {}),
          },
  });

  const turns = buildConversationTurns(
    messages,
    blobStore,
    activeUserMessage ? activeUserMessageIndex : -1,
  );

  const rootPromptMessagesJson = buildRootPromptMessagesJson(
    messages,
    systemPromptIds,
    blobStore,
    activeUserMessage ? activeUserMessageIndex : -1,
  );

  const conversationState = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson,
    turns,
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
  });

  const wireModelId = resolveCursorWireModelId(args.model);
  const modelDetails = create(ModelDetailsSchema, {
    modelId: wireModelId,
    displayModelId: wireModelId,
    displayName: wireModelId,
  });
  const requestedModel = create(RequestedModelSchema, {
    modelId: wireModelId,
    maxMode: false,
  });

  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    requestedModel,
    conversationId,
  });

  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });

  const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);
  return { requestBytes, blobStore };
}

// ---------------------------------------------------------------------------
// Response stream state machine — ordered block array (text/thinking/toolCall)
// ---------------------------------------------------------------------------
//
// Ported from oh-my-pi's `cursor.ts` (`:421` BlockState, `:2092`
// endCurrentTextBlock, `:2141` synthesizeCursorExecToolCall). The block array
// preserves the text→tool→text→tool interleaving so the assistant message's
// temporal order survives serialization; nolo's previous flat
// `content: string + tool_calls: []` split lost that ordering.

/**
 * One entry in the ordered content sequence of a Cursor assistant turn.
 *
 * Structurally identical to {@link AgentRuntimeOutputBlock} (defined in
 * `../types`); the canonical type now lives there so downstream consumers
 * (localLoop) share one shape. `result` is `{ content: string; metadata? }`
 * — same as `AgentRuntimeToolResult` — coerced at the return site without
 * any conversion.
 */

interface CursorStreamState {
  /** Ordered content blocks (text/thinking/toolCall interleaved). */
  blocks: AgentRuntimeOutputBlock[];
  /** Active text block being accumulated (null when no text block open). */
  currentTextBlock: { type: "text"; text: string } | null;
  /** Active thinking block being accumulated (null when none open). */
  currentThinkingBlock: { type: "thinking"; thinking: string } | null;
  outputTokens: number;
  stopReason: string;
  done: boolean;
}

export function createStreamState(): CursorStreamState {
  return {
    blocks: [],
    currentTextBlock: null,
    currentThinkingBlock: null,
    outputTokens: 0,
    stopReason: "stop",
    done: false,
  };
}

/**
 * Close the active text block (if any) and append it to `state.blocks`.
 * Mirrors oh-my-pi `:2092` endCurrentTextBlock. Idempotent: a no-op when no
 * text block is open.
 */
export function endCurrentTextBlock(state: CursorStreamState): void {
  if (state.currentTextBlock) {
    state.blocks.push(state.currentTextBlock);
    state.currentTextBlock = null;
  }
}

/**
 * Close the active thinking block (if any) and append it to `state.blocks`.
 * Mirrors oh-my-pi `:2105` endCurrentThinkingBlock. Idempotent.
 */
export function endCurrentThinkingBlock(state: CursorStreamState): void {
  if (state.currentThinkingBlock) {
    state.blocks.push(state.currentThinkingBlock);
    state.currentThinkingBlock = null;
  }
}

/**
 * Drive one AgentServerMessage through the stream state. Exported for tests.
 * Only the chat completions subset of interactionUpdate cases is handled:
 * textDelta, thinkingDelta, thinkingCompleted, turnEnded, tokenDelta.
 *
 * Block boundaries (ported from oh-my-pi `:2192` processInteractionUpdate):
 * - textDelta: open a text block on first delta, append subsequent deltas to
 *   the active block. A thinking block is closed first so text never merges
 *   into thinking.
 * - thinkingDelta: symmetric — close any open text block, then append to a
 *   thinking block (creating one if needed).
 */
export function processCursorServerMessage(
  msg: AgentServerMessage,
  state: CursorStreamState,
  onTextDelta?: (chunk: string) => void,
  onReasoningDelta?: (chunk: string) => void,
): void {
  const msgCase = msg.message.case;
  if (msgCase !== "interactionUpdate") return;
  const update: any = msg.message.value;
  const updateCase = update?.message?.case;
  const value: any = update?.message?.value;

  if (updateCase === "textDelta") {
    const delta: string = value?.text || "";
    if (delta) {
      // Switching from thinking to text closes the thinking block (oh-my-pi
      // :2192 fires text_start which implicitly ends any thinking block).
      if (state.currentThinkingBlock) endCurrentThinkingBlock(state);
      if (!state.currentTextBlock) {
        state.currentTextBlock = { type: "text", text: "" };
      }
      state.currentTextBlock.text += delta;
      onTextDelta?.(delta);
    }
  } else if (updateCase === "thinkingDelta") {
    const delta: string = value?.text || "";
    if (delta) {
      if (state.currentTextBlock) endCurrentTextBlock(state);
      if (!state.currentThinkingBlock) {
        state.currentThinkingBlock = { type: "thinking", thinking: "" };
      }
      state.currentThinkingBlock.thinking += delta;
      onReasoningDelta?.(delta);
    }
  } else if (updateCase === "thinkingCompleted") {
    // Close the thinking block when the server signals completion so a
    // subsequent textDelta starts a fresh text block rather than leaving the
    // thinking block dangling until the next tool/text boundary.
    endCurrentThinkingBlock(state);
  } else if (updateCase === "turnEnded") {
    state.done = true;
    state.stopReason = "stop";
  } else if (updateCase === "tokenDelta") {
    const tokens: number = value?.tokens || 0;
    state.outputTokens += tokens;
  }
}

// ---------------------------------------------------------------------------
// streamCursor — HTTP/2 ConnectRPC request + response stream
// ---------------------------------------------------------------------------

export type CursorProviderOptions = {
  accessToken: string;
  model: string;
  baseUrl?: string;
  systemPrompt?: string;
  conversationId?: string;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  /**
   * Mid-stream tool event callback. When a bridged tool (read/shell/grep/
   * write/delete/ls/mcp) is invoked and resolves during the exec channel,
   * the provider calls this at the moment of tool-call and tool-result so
   * CLI/Desktop can interleave text→tool→text without waiting for the whole
   * stream to end. Same shape as localLoop's `LocalAgentToolEvent`.
   */
  onToolEvent?: (event: {
    type: "tool-call" | "tool-result" | "tool-error";
    round: number;
    toolCallId: string;
    toolName: string;
    argumentsPreview?: string;
    elapsedMs?: number;
    summary?: string;
    content?: string;
    message?: string;
    metadata?: Record<string, unknown>;
  }) => void;
  /** Round number emitted on each `onToolEvent` (localLoop sets it). */
  toolEventRound?: number;
  /** OpenAI-format tools to advertise to the Cursor model (→ McpToolDefinition[]). */
  tools?: NoloToolDefinition[];
  /** Callback that executes a nolo tool call inline (sync exec channel). */
  executeTool?: (call: AgentRuntimeToolCallInput) => Promise<AgentRuntimeToolResult>;
};

/**
 * Open an HTTP/2 ConnectRPC stream to Cursor's AgentService and resolve with
 * the full assistant text once `turnEnded` arrives.
 *
 * Uses node:http2 directly (Cursor requires HTTP/2 + connect+proto).
 */
export async function streamCursorChat(
  messages: AgentRuntimeChatMessage[],
  options: CursorProviderOptions,
): Promise<AgentRuntimeResult> {
  const baseUrl = options.baseUrl || CURSOR_API_URL;
  const clientVersion = options.clientVersion || CURSOR_CLIENT_VERSION;
  const conversationId = options.conversationId ?? randomUUID();

  // Build the exec-bridge context: advertise nolo tools (converted to
  // McpToolDefinition[]) and bind the executeTool callback. The accumulated
  // toolCalls surface on the returned AgentRuntimeResult for localLoop
  // bookkeeping — the exec channel already executed them inline.
  const toolCalls: AgentRuntimeToolCall[] = [];
  const state = createStreamState();
  const execCtx: CursorExecContext = {
    tools: buildMcpToolDefinitions(options.tools),
    executeTool: options.executeTool,
    toolCalls,
    blocks: state.blocks,
    state,
    ...(options.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
    ...(typeof options.toolEventRound === "number" ? { toolEventRound: options.toolEventRound } : {}),
  };
  // Serial dispatch chain so exec replies (async) preserve order and
  // turnEnded only fires after all pending exec work settles.
  let dispatchChain: Promise<void> = Promise.resolve();

  const { requestBytes, blobStore } = buildCursorRunRequestBytes({
    model: options.model,
    systemPrompt: options.systemPrompt,
    messages,
    conversationId,
  });

  const h2Completion = Promise.withResolvers<void>();
  let resolveH2: (() => void) | undefined = h2Completion.resolve;
  let h2Client: http2.ClientHttp2Session | null = null;
  let h2Request: http2.ClientHttp2Stream | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let endStreamError: Error | null = null;

  const requestHeaders = {
    ":method": "POST",
    ":path": CURSOR_REQUEST_PATH,
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${options.accessToken}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": clientVersion,
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  };

  try {
    h2Client = http2.connect(baseUrl);
    h2Client.on("error", (e) => {
      h2Completion.reject(e);
    });
    h2Request = h2Client.request(requestHeaders);
    h2Request.on("response", (headers) => {
    });

    let pendingBuffer = Buffer.alloc(0);

    h2Request.on("data", (chunk: Buffer) => {
      pendingBuffer = Buffer.concat([pendingBuffer, chunk]);
      while (pendingBuffer.length >= 5) {
        const flags = pendingBuffer[0];
        const msgLen = pendingBuffer.readUInt32BE(1);
        if (pendingBuffer.length < 5 + msgLen) break;
        const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
        pendingBuffer = pendingBuffer.subarray(5 + msgLen);

        if (flags & CONNECT_END_STREAM_FLAG) {
          const endError = parseConnectEndStream(messageBytes);
          if (endError) {
            endStreamError = endError;
            h2Request?.close();
          }
          continue;
        }

        try {
          const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
          processCursorServerMessage(
            serverMessage,
            state,
            options.onTextDelta,
            options.onReasoningDelta,
          );

          // Handle KV blob requests inline (server resolves rootPromptMessagesJson / turns)
          handleKvServerMessage(serverMessage, blobStore, h2Request!);

          // Handle exec messages — requestContextArgs advertises tools; the
          // other cases bridge to nolo tools via the injected executeTool.
          // Serialized through dispatchChain so async exec replies preserve
          // order and don't race turnEnded.
          if (serverMessage.message.case === "execServerMessage") {
            dispatchChain = dispatchChain.then(() =>
              handleExecServerMessage(
                serverMessage.message.value as any,
                h2Request!,
                execCtx,
              ),
            );
          }

          const isTurnEnded =
            serverMessage.message.case === "interactionUpdate" &&
            serverMessage.message.value?.message?.case === "turnEnded";
          if (isTurnEnded && resolveH2) {
            // Only resolve once every pending exec dispatch has settled so the
            // stream result includes all synthesized tool_calls.
            const r = resolveH2;
            resolveH2 = undefined;
            dispatchChain = dispatchChain.then(() => r());
          }
        } catch (e) {
          // parse error — keep streaming, don't abort on a single bad frame
        }
      }
    });

    h2Request.on("trailers", (trailers) => {
      const status = trailers["grpc-status"];
      const msg = trailers["grpc-message"];
      if (status && status !== "0") {
        h2Completion.reject(
          new Error(
            `Cursor gRPC error ${status}: ${decodeURIComponent(String(msg || ""))}`,
          ),
        );
      }
    });

    h2Request.on("end", () => {
      resolveH2 = undefined;
      if (endStreamError) {
        h2Completion.reject(endStreamError);
        return;
      }
      h2Completion.resolve();
    });

    h2Request.on("error", (error) => {
      h2Completion.reject(error);
    });

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => {
          h2Request?.close();
          h2Completion.reject(new Error("Cursor stream aborted"));
        },
        { once: true },
      );
    }

    // Send the initial runRequest frame.
    h2Request.write(frameConnectMessage(requestBytes));

    // Heartbeat every 5s to keep the stream alive.
    heartbeatTimer = setInterval(() => {
      if (!h2Request || h2Request.closed) return;
      const heartbeat = create(AgentClientMessageSchema, {
        message: {
          case: "clientHeartbeat",
          value: create(ClientHeartbeatSchema, {}),
        },
      });
      const heartbeatBytes = toBinary(AgentClientMessageSchema, heartbeat);
      h2Request.write(frameConnectMessage(heartbeatBytes));
    }, HEARTBEAT_INTERVAL_MS);

    await h2Completion.promise;
    // Make sure every async exec dispatch has flushed its reply before we
    // return — the h2 stream end may arrive before the last exec promise
    // resolves, but the synthesized tool_calls must be on the result.
    await dispatchChain;
    // Flush any still-open block so the block array is the canonical record.
    endCurrentTextBlock(state);
    endCurrentThinkingBlock(state);
    // Serialize the ordered block array into the legacy `content` string and
    // `tool_calls` array. Text blocks are concatenated in arrival order; this
    // preserves the original temporal sequence while staying wire-compatible
    // with the flat-string `AgentRuntimeResult.content` contract.
    const content = state.blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    const thinkingContent = state.blocks
      .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
      .map((b) => b.thinking)
      .join("");
    const blockToolCalls = state.blocks
      .filter(
        (b): b is { type: "toolCall"; toolCall: AgentRuntimeToolCall; result?: AgentRuntimeToolResult } =>
          b.type === "toolCall",
      )
      .map((b) => b.toolCall);
    return {
      content,
      model: options.model,
      provider: "cursor",
      ...(thinkingContent ? { reasoning_content: thinkingContent } : {}),
      ...(state.outputTokens
        ? { usage: { output_tokens: state.outputTokens, total_tokens: state.outputTokens } }
        : {}),
      finish_reason: state.done ? "stop" : "length",
      trace: messages,
      ...(blockToolCalls.length > 0 ? { tool_calls: blockToolCalls } : {}),
      // Mark that the exec channel already ran every tool call inline so
      // localLoop skips re-execution and instead persists the results from
      // the block array as `role: tool` messages.
      // Pass the full interleaved block sequence (text/toolCall with
      // results) so downstream persistence can preserve the temporal order.
      ...(state.blocks.length > 0 ? { output: state.blocks } : {}),
    };
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    h2Request?.close();
    h2Client?.close();
  }
}

// ---------------------------------------------------------------------------
// KV blob handling — the server asks for blob content via KvServerMessage.
// For the chat-only path we serve them from the in-memory blob store built
// during request construction.
// ---------------------------------------------------------------------------

import {
  GetBlobResultSchema,
  KvClientMessageSchema,
  SetBlobResultSchema,
} from "./agent_pb";

// ---------------------------------------------------------------------------
// Exec handling — Cursor's AgentService always sends a `requestContextArgs`
// exec message before producing any text output. We reply with the injected
// nolo tool definitions (when configured) so the model can request them via
// `mcpArgs`; native Cursor exec requests (`readArgs`/`shellArgs`/`grepArgs`/
// `writeArgs`/`deleteArgs`/`lsArgs`) are bridged to the matching nolo workspace
// tool by synthesizing an `AgentRuntimeToolCall`, executing it through the
// injected `executeTool` callback, and converting the result back to the
// corresponding protobuf Result. The synthesized `tool_calls` are accumulated
// onto the stream result so the localLoop can record them without re-executing
// them (the exec channel already ran the tool inline).
// ---------------------------------------------------------------------------

/**
 * OpenAI-format tool definition (the element type of `buildOpenAiTools`).
 * Used as the input shape for {@link buildMcpToolDefinitions}.
 */
export type NoloToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/**
 * Convert OpenAI-format nolo tools into Cursor's `McpToolDefinition[]` so the
 * server advertises them to the model (the model then calls them via
 * `mcpArgs`). The `inputSchema` is a protobuf `Value`-encoded JSON schema;
 * we mirror oh-my-pi's `buildMcpToolDefinitions` for wire compatibility.
 *
 * Exported for tests.
 */
export function buildMcpToolDefinitions(
  tools: readonly NoloToolDefinition[] | undefined,
): McpToolDefinition[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool) => {
    const parameters = tool.function.parameters ?? {
      type: "object",
      properties: {},
      required: [],
    };
    const schemaValue = (typeof parameters === "object" && parameters
      ? (parameters as JsonValue)
      : ({ type: "object", properties: {}, required: [] } as JsonValue));
    const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, schemaValue));
    return create(McpToolDefinitionSchema, {
      name: tool.function.name,
      description: tool.function.description ?? "",
      providerIdentifier: "nolo",
      toolName: tool.function.name,
      inputSchema,
    });
  });
}

// ---------------------------------------------------------------------------
// Tool bridge — synthesize AgentRuntimeToolCall, execute via injected
// executeTool, convert AgentRuntimeToolResult back to protobuf Result.
// ---------------------------------------------------------------------------

/**
 * Context threaded through every `handleExecServerMessage` dispatch. Carries
 * the injected nolo tools (as McpToolDefinition[] for `requestContextArgs`),
 * the `executeTool` callback, the blob store, and a running list of
 * synthesized `AgentRuntimeToolCall`s so `streamCursorChat` can expose them
 * on the final `AgentRuntimeResult.tool_calls` (for localLoop bookkeeping —
 * the exec channel already executed them inline, so the loop must NOT
 * re-run them).
 */
export type CursorExecContext = {
  tools: McpToolDefinition[];
  executeTool?: (call: AgentRuntimeToolCallInput) => Promise<AgentRuntimeToolResult>;
  /** Synthesized tool calls (OpenAI shape) for the result's `tool_calls`. */
  toolCalls: AgentRuntimeToolCall[];
  /**
   * Ordered block array shared with {@link createStreamState}. The exec
   * channel pushes `toolCall` blocks here (closing any open text/thinking
   * block first) so {@link streamCursorChat} can serialize the canonical
   * text→tool→text sequence.
   */
  blocks: AgentRuntimeOutputBlock[];
  /** Active stream state, used to close open text/thinking blocks. */
  state: CursorStreamState;
  /** Mid-stream tool event callback (forwarded from options). */
  onToolEvent?: CursorProviderOptions["onToolEvent"];
  /** Round number stamped onto each emitted tool event. */
  toolEventRound?: number;
};

/** Extract the text content of a nolo tool result (string). */
function toolResultText(result: AgentRuntimeToolResult): string {
  return typeof result.content === "string" ? result.content : "";
}

/** Best-effort detection of an error result using metadata hints. */
function toolResultIsError(result: AgentRuntimeToolResult): boolean {
  const meta = result.metadata as Record<string, unknown> | undefined;
  if (!meta) return false;
  if (typeof meta.error === "string" && meta.error.length > 0) return true;
  if (typeof meta.exitCode === "number" && meta.exitCode !== 0) return true;
  if (typeof meta.reason === "string" && meta.reason === "error") return true;
  return false;
}

function toolResultWasTruncated(result: AgentRuntimeToolResult): boolean {
  const meta = result.metadata as Record<string, unknown> | undefined;
  return Boolean(meta?.truncated);
}

// ── readArgs → ReadResult ──

export function buildReadResultFromToolResult(
  path: string,
  result: AgentRuntimeToolResult,
): ReadResult {
  const text = toolResultText(result);
  if (toolResultIsError(result)) {
    return create(ReadResultSchema, {
      result: {
        case: "error",
        value: create(ReadErrorSchema, { path, error: text || "Read failed" }),
      },
    });
  }
  const totalLines = text ? text.split("\n").length : 0;
  return create(ReadResultSchema, {
    result: {
      case: "success",
      value: create(ReadSuccessSchema, {
        path,
        totalLines,
        fileSize: BigInt(Buffer.byteLength(text, "utf-8")),
        truncated: toolResultWasTruncated(result),
        output: { case: "content", value: text },
      }),
    },
  });
}

// ── shellArgs → ShellResult ──

export function buildShellResultFromToolResult(
  args: { command: string; workingDirectory: string },
  result: AgentRuntimeToolResult,
): ShellResult {
  const output = toolResultText(result);
  if (toolResultIsError(result)) {
    return create(ShellResultSchema, {
      result: {
        case: "failure",
        value: create(ShellFailureSchema, {
          command: args.command,
          workingDirectory: args.workingDirectory,
          exitCode:
            typeof (result.metadata as Record<string, unknown> | undefined)?.exitCode === "number"
              ? ((result.metadata as Record<string, unknown>).exitCode as number)
              : 1,
          signal: "",
          stdout: "",
          stderr: output || "Shell failed",
          executionTime: 0,
          aborted: false,
        }),
      },
    });
  }
  return create(ShellResultSchema, {
    result: {
      case: "success",
      value: create(ShellSuccessSchema, {
        command: args.command,
        workingDirectory: args.workingDirectory,
        exitCode: 0,
        signal: "",
        stdout: output,
        stderr: "",
        executionTime: 0,
      }),
    },
  });
}

// ── writeArgs → WriteResult ──

export function buildWriteResultFromToolResult(
  args: { path: string; fileText?: string; fileBytes?: Uint8Array },
  result: AgentRuntimeToolResult,
): WriteResult {
  const text = toolResultText(result);
  if (toolResultIsError(result)) {
    return create(WriteResultSchema, {
      result: {
        case: "error",
        value: create(WriteErrorSchema, { path: args.path, error: text || "Write failed" }),
      },
    });
  }
  const fileText = args.fileText ?? "";
  const fileSize = args.fileBytes?.length ?? Buffer.byteLength(fileText, "utf-8");
  const linesCreated = fileText ? fileText.split("\n").length : 0;
  return create(WriteResultSchema, {
    result: {
      case: "success",
      value: create(WriteSuccessSchema, {
        path: args.path,
        linesCreated,
        fileSize,
      }),
    },
  });
}

// ── deleteArgs → DeleteResult ──

export function buildDeleteResultFromToolResult(
  path: string,
  result: AgentRuntimeToolResult,
): DeleteResult {
  const text = toolResultText(result);
  if (toolResultIsError(result)) {
    return create(DeleteResultSchema, {
      result: {
        case: "error",
        value: create(DeleteErrorSchema, { path, error: text || "Delete failed" }),
      },
    });
  }
  return create(DeleteResultSchema, {
    result: {
      case: "success",
      value: create(DeleteSuccessSchema, {
        path,
        deletedFile: path,
        fileSize: BigInt(0),
        prevContent: "",
      }),
    },
  });
}

// ── grepArgs → GrepResult ──

export function buildGrepResultFromToolResult(
  args: { pattern: string; path?: string; outputMode?: string },
  result: AgentRuntimeToolResult,
): GrepResult {
  const text = toolResultText(result);
  if (toolResultIsError(result)) {
    return create(GrepResultSchema, {
      result: {
        case: "error",
        value: create(GrepErrorSchema, { error: text || "Grep failed" }),
      },
    });
  }
  const outputMode = args.outputMode || "content";
  const clientTruncated = toolResultWasTruncated(result);
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("[") && !line.toLowerCase().startsWith("no matches"));
  const workspaceKey = args.path || ".";
  let unionResult: GrepUnionResult;
  if (outputMode === "files_with_matches") {
    const files = lines;
    unionResult = create(GrepUnionResultSchema, {
      result: {
        case: "files",
        value: create(GrepFilesResultSchema, {
          files,
          totalFiles: files.length,
          clientTruncated,
          ripgrepTruncated: false,
        }),
      },
    });
  } else {
    // content mode — parse `file:line: content` lines into GrepFileMatch[]
    const matchMap = new Map<string, Array<{ line: number; content: string; isContextLine: boolean }>>();
    let totalMatchedLines = 0;
    for (const line of lines) {
      const matchLine = line.match(/^(.+?):(\d+):\s?(.*)$/);
      const contextLine = line.match(/^(.+?)-(\d+)-\s?(.*)$/);
      const match = matchLine ?? contextLine;
      if (!match) continue;
      const [, file, lineNumber, content] = match;
      const isContextLine = Boolean(contextLine);
      const list = matchMap.get(file) ?? [];
      list.push({ line: Number(lineNumber), content, isContextLine });
      matchMap.set(file, list);
      if (!isContextLine) totalMatchedLines += 1;
    }
    const matches = Array.from(matchMap.entries()).map(([file, ms]) =>
      create(GrepFileMatchSchema, {
        file,
        matches: ms.map((entry) =>
          create(GrepContentMatchSchema, {
            lineNumber: entry.line,
            content: entry.content,
            contentTruncated: false,
            isContextLine: entry.isContextLine,
          }),
        ),
      }),
    );
    const totalLines = matches.reduce((sum, entry) => sum + entry.matches.length, 0);
    unionResult = create(GrepUnionResultSchema, {
      result: {
        case: "content",
        value: create(GrepContentResultSchema, {
          matches,
          totalLines,
          totalMatchedLines,
          clientTruncated,
          ripgrepTruncated: false,
        }),
      },
    });
  }
  return create(GrepResultSchema, {
    result: {
      case: "success",
      value: create(GrepSuccessSchema, {
        pattern: args.pattern,
        path: args.path || "",
        outputMode,
        workspaceResults: { [workspaceKey]: unionResult },
      }),
    },
  });
}

// ── lsArgs → LsResult ──

export function buildLsResultFromToolResult(
  path: string,
  result: AgentRuntimeToolResult,
): LsResult {
  const text = toolResultText(result);
  if (toolResultIsError(result)) {
    return create(LsResultSchema, {
      result: {
        case: "error",
        value: create(LsErrorSchema, { path, error: text || "Ls failed" }),
      },
    });
  }
  const rootPath = path || ".";
  const entries = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("["));
  const childrenDirs: LsDirectoryTreeNode[] = [];
  const childrenFiles: LsDirectoryTreeNode_File[] = [];
  for (const entry of entries) {
    const name = entry.split(" (")[0];
    if (name.endsWith("/")) {
      const dirName = name.slice(0, -1);
      childrenDirs.push(
        create(LsDirectoryTreeNodeSchema, {
          absPath: `${rootPath.replace(/\/$/, "")}/${dirName}`,
          childrenDirs: [],
          childrenFiles: [],
          childrenWereProcessed: false,
          fullSubtreeExtensionCounts: {},
          numFiles: 0,
        }),
      );
    } else {
      childrenFiles.push(create(LsDirectoryTreeNode_FileSchema, { name }));
    }
  }
  const root = create(LsDirectoryTreeNodeSchema, {
    absPath: rootPath,
    childrenDirs,
    childrenFiles,
    childrenWereProcessed: true,
    fullSubtreeExtensionCounts: {},
    numFiles: childrenFiles.length,
  });
  return create(LsResultSchema, {
    result: {
      case: "success",
      value: create(LsSuccessSchema, { directoryTreeRoot: root }),
    },
  });
}

// ── mcpArgs → McpResult ──

export function buildMcpResultFromToolResult(result: AgentRuntimeToolResult): McpResult {
  const text = toolResultText(result);
  if (toolResultIsError(result)) {
    return create(McpResultSchema, {
      result: {
        case: "error",
        value: create(McpErrorSchema, { error: text || "MCP tool failed" }),
      },
    });
  }
  const content = [
    create(McpToolResultContentItemSchema, {
      content: {
        case: "text",
        value: create(McpTextContentSchema, { text }),
      },
    }),
  ];
  return create(McpResultSchema, {
    result: {
      case: "success",
      value: create(McpSuccessSchema, { content, isError: false }),
    },
  });
}

function buildMcpToolNotFoundResult(toolName: string): McpResult {
  return create(McpResultSchema, {
    result: {
      case: "toolNotFound",
      value: create(McpToolNotFoundSchema, { name: toolName, availableTools: [] }),
    },
  });
}

function sendExecClientMessage(
  h2Request: http2.ClientHttp2Stream,
  execMsg: any,
  messageCase: string,
  value: any,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: {
      case: messageCase as any,
      value: value as any,
    },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  });
  const responseBytes = toBinary(AgentClientMessageSchema, clientMessage);
  h2Request.write(frameConnectMessage(responseBytes));
}

/**
 * Synthesize an `AgentRuntimeToolCall` (OpenAI function-call shape) for a
 * Cursor exec-channel request and push it onto the accumulator so the
 * stream result surfaces it to the localLoop for bookkeeping. The exec
 * channel already executes the tool inline, so the localLoop must NOT
 * re-run these calls.
 *
 * Ported from oh-my-pi `:2141` synthesizeCursorExecToolCall: **before**
 * pushing the toolCall block we close any open text/thinking block so the
 * block array keeps the true text→tool→text→tool order — the preceding
 * assistant text belongs to the turn before the tool call, not after.
 */
function synthesizeCursorExecToolCall(
  ctx: CursorExecContext,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): { type: "toolCall"; toolCall: AgentRuntimeToolCall; result?: AgentRuntimeToolResult } {
  endCurrentTextBlock(ctx.state);
  endCurrentThinkingBlock(ctx.state);
  const toolCall: AgentRuntimeToolCall = {
    id: toolCallId,
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify(args),
    },
  };
  ctx.toolCalls.push(toolCall);
  // Push the toolCall block onto the shared ordered array; `result` is
  // filled by handleExecServerMessage once the inline exec resolves.
  const block: AgentRuntimeOutputBlock = { type: "toolCall", toolCall };
  ctx.blocks.push(block);
  return block as { type: "toolCall"; toolCall: AgentRuntimeToolCall; result?: AgentRuntimeToolResult };
}

/** Decode a single `McpArgs.args` map entry (protobuf Value → JSON value). */
function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value);
    const json = toJson(ValueSchema, parsed) as JsonValue;
    if (typeof json === "string") {
      const trimmed = json.trim();
      if (!trimmed) return json;
      try {
        return JSON.parse(trimmed);
      } catch {
        return json;
      }
    }
    return json;
  } catch {
    const text = new TextDecoder().decode(value);
    const trimmed = text.trim();
    if (!trimmed) return text;
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
}

/**
 * Dispatch a single `ExecServerMessage`. When `ctx.executeTool` is present the
 * native Cursor exec cases (`readArgs`/`shellArgs`/`grepArgs`/`writeArgs`/
 * `deleteArgs`/`lsArgs`) are bridged to the matching nolo workspace tool;
 * `mcpArgs` dispatches to the tool named in `args.toolName`. When
 * `executeTool` is absent we fall back to a "rejected" reply so the server
 * proceeds (chat-only behaviour) — preserving the previous contract for
 * callers that don't inject tools.
 */
export async function handleExecServerMessage(
  execMsg: any,
  h2Request: http2.ClientHttp2Stream,
  ctx: CursorExecContext,
): Promise<void> {
  const execCase = execMsg.message?.case;

  if (execCase === "requestContextArgs") {
    // Advertise the injected nolo tools so the model can call them via mcpArgs.
    const requestContext = create(RequestContextSchema, {
      rules: [],
      repositoryInfo: [],
      tools: ctx.tools,
      gitRepos: [],
      projectLayouts: [],
      mcpInstructions: [],
      fileContents: {},
      customSubagents: [],
    });
    const requestContextResult = create(RequestContextResultSchema, {
      result: {
        case: "success",
        value: create(RequestContextSuccessSchema, { requestContext }),
      },
    });
    sendExecClientMessage(h2Request, execMsg, "requestContextResult", requestContextResult);
    return;
  }

  if (!execCase) return;

  switch (execCase) {
    case "readArgs": {
      const args = execMsg.message.value;
      if (!args.toolCallId) args.toolCallId = randomUUID();
      const path: string = args.path;
      const toolCallBlock = synthesizeCursorExecToolCall(ctx, args.toolCallId, "readFile", { path });
      let result: ReadResult;
      if (ctx.executeTool) {
        const toolCallArgs = JSON.stringify({ path });
        emitToolEvent(ctx, {
          type: "tool-call",
          toolCallId: args.toolCallId,
          toolName: "readFile",
          argumentsPreview: clipArgumentsPreview("readFile", toolCallArgs),
        });
        const startedAt = Date.now();
        try {
          const toolResult = await ctx.executeTool({
            id: args.toolCallId,
            name: "readFile",
            arguments: toolCallArgs,
          });
          toolCallBlock.result = toolResult;
          result = buildReadResultFromToolResult(path, toolResult);
          emitToolEvent(ctx, {
            type: "tool-result",
            toolCallId: args.toolCallId,
            toolName: "readFile",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            content: toolResult.content,
            ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
          });
        } catch (e) {
          result = create(ReadResultSchema, {
            result: {
              case: "error",
              value: create(ReadErrorSchema, { path, error: toErrorMessage(e) }),
            },
          });
          emitToolEvent(ctx, {
            type: "tool-error",
            toolCallId: args.toolCallId,
            toolName: "readFile",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            message: toErrorMessage(e),
          });
        }
      } else {
        result = create(ReadResultSchema, {
          result: {
            case: "rejected",
            value: create(ReadRejectedSchema, { path, reason: "Tool execution not configured" }),
          },
        });
      }
      sendExecClientMessage(h2Request, execMsg, "readResult", result);
      return;
    }

    case "shellArgs":
    case "shellStreamArgs": {
      const args = execMsg.message.value;
      if (!args.toolCallId) args.toolCallId = randomUUID();
      const command: string = args.command;
      const workingDirectory: string = args.workingDirectory || process.cwd();
      const shellTimeout = args.timeout && args.timeout > 0 ? args.timeout : undefined;
      const toolCallBlock = synthesizeCursorExecToolCall(ctx, args.toolCallId, "execShell", {
        command,
        cwd: workingDirectory,
        ...(shellTimeout ? { timeout: shellTimeout } : {}),
      });
      let result: ShellResult;
      if (ctx.executeTool) {
        const toolCallArgs = JSON.stringify({
          command,
          ...(workingDirectory ? { cwd: workingDirectory } : {}),
          ...(shellTimeout ? { timeout: shellTimeout } : {}),
        });
        emitToolEvent(ctx, {
          type: "tool-call",
          toolCallId: args.toolCallId,
          toolName: "execShell",
          argumentsPreview: clipArgumentsPreview("execShell", toolCallArgs),
        });
        const startedAt = Date.now();
        try {
          const toolResult = await ctx.executeTool({
            id: args.toolCallId,
            name: "execShell",
            arguments: toolCallArgs,
          });
          toolCallBlock.result = toolResult;
          result = buildShellResultFromToolResult({ command, workingDirectory }, toolResult);
          emitToolEvent(ctx, {
            type: "tool-result",
            toolCallId: args.toolCallId,
            toolName: "execShell",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            content: toolResult.content,
            ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
          });
        } catch (e) {
          result = create(ShellResultSchema, {
            result: {
              case: "failure",
              value: create(ShellFailureSchema, {
                command,
                workingDirectory,
                exitCode: 1,
                signal: "",
                stdout: "",
                stderr: toErrorMessage(e),
                executionTime: 0,
                aborted: false,
              }),
            },
          });
          emitToolEvent(ctx, {
            type: "tool-error",
            toolCallId: args.toolCallId,
            toolName: "execShell",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            message: toErrorMessage(e),
          });
        }
      } else {
        result = create(ShellResultSchema, {
          result: {
            case: "rejected",
            value: create(ShellRejectedSchema, {
              command,
              workingDirectory,
              reason: "Tool execution not configured",
              isReadonly: false,
            }),
          },
        });
      }
      sendExecClientMessage(h2Request, execMsg, "shellResult", result);
      return;
    }

    case "backgroundShellSpawnArgs": {
      const args = execMsg.message.value;
      const result = create(BackgroundShellSpawnResultSchema, {
        result: {
          case: "rejected",
          value: create(ShellRejectedSchema, {
            command: args.command,
            workingDirectory: args.workingDirectory,
            reason: "Background shells not supported",
            isReadonly: false,
          }),
        },
      });
      sendExecClientMessage(h2Request, execMsg, "backgroundShellSpawnResult", result);
      return;
    }

    case "grepArgs": {
      const args = execMsg.message.value;
      if (!args.toolCallId) args.toolCallId = randomUUID();
      const searchPath = args.glob
        ? `${args.path || "."}/${args.glob}`
        : args.path || ".";
      const pattern: string = args.pattern || "";
      const toolCallBlock = synthesizeCursorExecToolCall(ctx, args.toolCallId, "searchFiles", {
        query: pattern,
        path: searchPath,
        ...(args.caseInsensitive === true ? { caseSensitive: false } : {}),
      });
      let result: GrepResult;
      if (ctx.executeTool) {
        const toolCallArgs = JSON.stringify({
          query: pattern,
          path: searchPath,
          ...(args.caseInsensitive === true ? { caseSensitive: false } : {}),
        });
        emitToolEvent(ctx, {
          type: "tool-call",
          toolCallId: args.toolCallId,
          toolName: "searchFiles",
          argumentsPreview: clipArgumentsPreview("searchFiles", toolCallArgs),
        });
        const startedAt = Date.now();
        try {
          const toolResult = await ctx.executeTool({
            id: args.toolCallId,
            name: "searchFiles",
            arguments: toolCallArgs,
          });
          toolCallBlock.result = toolResult;
          result = buildGrepResultFromToolResult(
            { pattern, path: searchPath, outputMode: args.outputMode },
            toolResult,
          );
          emitToolEvent(ctx, {
            type: "tool-result",
            toolCallId: args.toolCallId,
            toolName: "searchFiles",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            content: toolResult.content,
            ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
          });
        } catch (e) {
          result = create(GrepResultSchema, {
            result: {
              case: "error",
              value: create(GrepErrorSchema, { error: toErrorMessage(e) }),
            },
          });
          emitToolEvent(ctx, {
            type: "tool-error",
            toolCallId: args.toolCallId,
            toolName: "searchFiles",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            message: toErrorMessage(e),
          });
        }
      } else {
        result = create(GrepResultSchema, {
          result: {
            case: "error",
            value: create(GrepErrorSchema, { error: "Tool execution not configured" }),
          },
        });
      }
      sendExecClientMessage(h2Request, execMsg, "grepResult", result);
      return;
    }

    case "writeArgs": {
      const args = execMsg.message.value;
      if (!args.toolCallId) args.toolCallId = randomUUID();
      const path: string = args.path;
      const content =
        args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
      const toolCallBlock = synthesizeCursorExecToolCall(ctx, args.toolCallId, "writeFile", { path, content });
      let result: WriteResult;
      if (ctx.executeTool) {
        const toolCallArgs = JSON.stringify({ path, content });
        emitToolEvent(ctx, {
          type: "tool-call",
          toolCallId: args.toolCallId,
          toolName: "writeFile",
          argumentsPreview: clipArgumentsPreview("writeFile", toolCallArgs),
        });
        const startedAt = Date.now();
        try {
          const toolResult = await ctx.executeTool({
            id: args.toolCallId,
            name: "writeFile",
            arguments: toolCallArgs,
          });
          toolCallBlock.result = toolResult;
          result = buildWriteResultFromToolResult(
            { path, fileText: args.fileText, fileBytes: args.fileBytes },
            toolResult,
          );
          emitToolEvent(ctx, {
            type: "tool-result",
            toolCallId: args.toolCallId,
            toolName: "writeFile",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            content: toolResult.content,
            ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
          });
        } catch (e) {
          result = create(WriteResultSchema, {
            result: {
              case: "error",
              value: create(WriteErrorSchema, { path, error: toErrorMessage(e) }),
            },
          });
          emitToolEvent(ctx, {
            type: "tool-error",
            toolCallId: args.toolCallId,
            toolName: "writeFile",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            message: toErrorMessage(e),
          });
        }
      } else {
        result = create(WriteResultSchema, {
          result: {
            case: "rejected",
            value: create(WriteRejectedSchema, { path, reason: "Tool execution not configured" }),
          },
        });
      }
      sendExecClientMessage(h2Request, execMsg, "writeResult", result);
      return;
    }

    case "deleteArgs": {
      const args = execMsg.message.value;
      if (!args.toolCallId) args.toolCallId = randomUUID();
      const path: string = args.path;
      const toolCallBlock = synthesizeCursorExecToolCall(ctx, args.toolCallId, "deleteFile", { path });
      let result: DeleteResult;
      if (ctx.executeTool) {
        const toolCallArgs = JSON.stringify({ path });
        emitToolEvent(ctx, {
          type: "tool-call",
          toolCallId: args.toolCallId,
          toolName: "deleteFile",
          argumentsPreview: clipArgumentsPreview("deleteFile", toolCallArgs),
        });
        const startedAt = Date.now();
        try {
          const toolResult = await ctx.executeTool({
            id: args.toolCallId,
            name: "deleteFile",
            arguments: toolCallArgs,
          });
          toolCallBlock.result = toolResult;
          result = buildDeleteResultFromToolResult(path, toolResult);
          emitToolEvent(ctx, {
            type: "tool-result",
            toolCallId: args.toolCallId,
            toolName: "deleteFile",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            content: toolResult.content,
            ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
          });
        } catch (e) {
          result = create(DeleteResultSchema, {
            result: {
              case: "error",
              value: create(DeleteErrorSchema, { path, error: toErrorMessage(e) }),
            },
          });
          emitToolEvent(ctx, {
            type: "tool-error",
            toolCallId: args.toolCallId,
            toolName: "deleteFile",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            message: toErrorMessage(e),
          });
        }
      } else {
        result = create(DeleteResultSchema, {
          result: {
            case: "rejected",
            value: create(DeleteRejectedSchema, { path, reason: "Tool execution not configured" }),
          },
        });
      }
      sendExecClientMessage(h2Request, execMsg, "deleteResult", result);
      return;
    }

    case "lsArgs": {
      const args = execMsg.message.value;
      if (!args.toolCallId) args.toolCallId = randomUUID();
      const path: string = args.path;
      const toolCallBlock = synthesizeCursorExecToolCall(ctx, args.toolCallId, "listFiles", { path });
      let result: LsResult;
      if (ctx.executeTool) {
        const toolCallArgs = JSON.stringify({ path });
        emitToolEvent(ctx, {
          type: "tool-call",
          toolCallId: args.toolCallId,
          toolName: "listFiles",
          argumentsPreview: clipArgumentsPreview("listFiles", toolCallArgs),
        });
        const startedAt = Date.now();
        try {
          const toolResult = await ctx.executeTool({
            id: args.toolCallId,
            name: "listFiles",
            arguments: toolCallArgs,
          });
          toolCallBlock.result = toolResult;
          result = buildLsResultFromToolResult(path, toolResult);
          emitToolEvent(ctx, {
            type: "tool-result",
            toolCallId: args.toolCallId,
            toolName: "listFiles",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            content: toolResult.content,
            ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
          });
        } catch (e) {
          result = create(LsResultSchema, {
            result: {
              case: "error",
              value: create(LsErrorSchema, { path, error: toErrorMessage(e) }),
            },
          });
          emitToolEvent(ctx, {
            type: "tool-error",
            toolCallId: args.toolCallId,
            toolName: "listFiles",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            message: toErrorMessage(e),
          });
        }
      } else {
        result = create(LsResultSchema, {
          result: {
            case: "rejected",
            value: create(LsRejectedSchema, { path, reason: "Tool execution not configured" }),
          },
        });
      }
      sendExecClientMessage(h2Request, execMsg, "lsResult", result);
      return;
    }

    case "mcpArgs": {
      const args = execMsg.message.value;
      const toolName: string = args.toolName || args.name;
      const decodedArgs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args.args ?? {})) {
        decodedArgs[key] = decodeMcpArgValue(value as Uint8Array);
      }
      if (!args.toolCallId) args.toolCallId = randomUUID();
      const toolCallBlock = synthesizeCursorExecToolCall(ctx, args.toolCallId, toolName, decodedArgs);
      let result: McpResult;
      if (ctx.executeTool) {
        const toolCallArgs = JSON.stringify(decodedArgs);
        emitToolEvent(ctx, {
          type: "tool-call",
          toolCallId: args.toolCallId,
          toolName,
          argumentsPreview: clipArgumentsPreview(toolName, toolCallArgs),
        });
        const startedAt = Date.now();
        try {
          const toolResult = await ctx.executeTool({
            id: args.toolCallId,
            name: toolName,
            arguments: toolCallArgs,
          });
          toolCallBlock.result = toolResult;
          result = buildMcpResultFromToolResult(toolResult);
          emitToolEvent(ctx, {
            type: "tool-result",
            toolCallId: args.toolCallId,
            toolName,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            content: toolResult.content,
            ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
          });
        } catch (e) {
          result = create(McpResultSchema, {
            result: {
              case: "error",
              value: create(McpErrorSchema, { error: toErrorMessage(e) }),
            },
          });
          emitToolEvent(ctx, {
            type: "tool-error",
            toolCallId: args.toolCallId,
            toolName,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            message: toErrorMessage(e),
          });
        }
      } else {
        result = buildMcpToolNotFoundResult(toolName);
      }
      sendExecClientMessage(h2Request, execMsg, "mcpResult", result);
      return;
    }

    default: {
      // Unknown / unsupported exec case (diagnosticsArgs, fetchArgs, etc.) —
      // log so the heartbeat keeps the stream alive; the server proceeds.
      console.warn(`[cursor-provider] unhandled exec case: ${execCase}`);
      return;
    }
  }
}

function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Build a short tool-event arguments preview (path/command/query — not raw JSON).
 */
function clipArgumentsPreview(toolName: string, rawArgs: string): string {
  return summarizeToolArguments(toolName, rawArgs);
}

/**
 * Emit a mid-stream tool event if the exec context carries `onToolEvent`.
 * `round` defaults to `ctx.toolEventRound ?? 0`.
 */
function emitToolEvent(
  ctx: CursorExecContext,
  event: {
    type: "tool-call" | "tool-result" | "tool-error";
    toolCallId: string;
    toolName: string;
    argumentsPreview?: string;
    elapsedMs?: number;
    summary?: string;
    content?: string;
    message?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  if (!ctx.onToolEvent) return;
  ctx.onToolEvent({ round: ctx.toolEventRound ?? 0, ...event });
}

function handleKvServerMessage(
  serverMessage: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  h2Request: http2.ClientHttp2Stream,
): void {
  if (serverMessage.message.case !== "kvServerMessage") return;
  const kvMsg: any = serverMessage.message.value;
  const kvCase = kvMsg?.message?.case;
  if (kvCase === "getBlobArgs") {
    const blobId: Uint8Array = kvMsg.message.value.blobId;
    const blobIdKey = Buffer.from(blobId).toString("hex");
    const blobData = blobStore.get(blobIdKey);
    const response = create(KvClientMessageSchema, {
      id: kvMsg.id,
      message: {
        case: "getBlobResult",
        value: create(GetBlobResultSchema, blobData ? { blobData } : {}),
      },
    });
    const kvClientMessage = create(AgentClientMessageSchema, {
      message: { case: "kvClientMessage", value: response },
    });
    const responseBytes = toBinary(AgentClientMessageSchema, kvClientMessage);
    h2Request.write(frameConnectMessage(responseBytes));
  } else if (kvCase === "setBlobArgs") {
    const { blobId, blobData }: { blobId: Uint8Array; blobData: Uint8Array } =
      kvMsg.message.value;
    const blobIdKey = Buffer.from(blobId).toString("hex");
    blobStore.set(blobIdKey, blobData);
    const response = create(KvClientMessageSchema, {
      id: kvMsg.id,
      message: {
        case: "setBlobResult",
        value: create(SetBlobResultSchema, {}),
      },
    });
    const kvClientMessage = create(AgentClientMessageSchema, {
      message: { case: "kvClientMessage", value: response },
    });
    const responseBytes = toBinary(AgentClientMessageSchema, kvClientMessage);
    h2Request.write(frameConnectMessage(responseBytes));
  }
}

// ---------------------------------------------------------------------------
// AgentRuntimeProvider adapter
// ---------------------------------------------------------------------------

export type CursorProviderConfig = {
  accessToken: string;
  model: string;
  systemPrompt?: string;
  baseUrl?: string;
  clientVersion?: string;
  /** OpenAI-format tools to advertise to the Cursor model (→ McpToolDefinition[]). */
  tools?: NoloToolDefinition[];
  /** Callback that executes a nolo tool call inline (sync exec channel). */
  executeTool?: (call: AgentRuntimeToolCallInput) => Promise<AgentRuntimeToolResult>;
};

export function createCursorProvider(
  config: CursorProviderConfig,
): AgentRuntimeProvider {
  return {
    model: config.model,
    complete: async (
      messages: AgentRuntimeChatMessage[],
      options?: AgentRuntimeCompleteOptions,
    ): Promise<AgentRuntimeResult> => {
      return streamCursorChat(messages, {
        accessToken: config.accessToken,
        model: config.model,
        systemPrompt: config.systemPrompt,
        baseUrl: config.baseUrl,
        clientVersion: config.clientVersion,
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.executeTool ? { executeTool: config.executeTool } : {}),
        ...(options?.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
        ...(options?.onReasoningDelta
          ? { onReasoningDelta: options.onReasoningDelta }
          : {}),
        ...(options?.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
        ...(typeof options?.toolEventRound === "number"
          ? { toolEventRound: options.toolEventRound }
          : {}),
      });
    },
  };
}

/**
 * Detect cursor OAuth agents (apiKeyRef === "cursor").
 * Mirrors isAnthropicOAuthAgent / isAntigravityOAuthAgent.
 */
export function isCursorOAuthAgent(
  agent: Pick<AgentRuntimeAgentConfig, "apiKeyRef">,
): boolean {
  return agent.apiKeyRef?.trim().toLowerCase() === "cursor";
}