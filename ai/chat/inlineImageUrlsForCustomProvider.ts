import { isNoloHostedProvider } from "../llm/kimi";

type ImageFetchResult = {
  ok: boolean;
  mimeType?: string;
  bytes?: Uint8Array;
  error?: string;
};

type InlineOptions = {
  shouldInline: boolean;
  fetchImage?: (url: string) => Promise<ImageFetchResult>;
};

const FILE_CONTENT_PATH = "/api/v1/db/file/content/";

/**
 * Providers that reject remote image URLs and require base64 data URIs.
 * Shared contract for client chat + server chat-proxy/agent-run (same as custom
 * OpenAI-compatible hosts / Ollama Cloud).
 */
export const shouldInlineImageUrlsForAgent = (
  agentConfig:
    | { apiSource?: string | null; model?: string | null; provider?: string | null }
    | null
    | undefined,
) => {
  const apiSource = agentConfig?.apiSource?.toLowerCase();
  const provider = agentConfig?.provider?.toLowerCase();
  const model = agentConfig?.model?.toLowerCase();
  if (apiSource === "custom" || provider === "custom") return true;
  // Platform nolo → Ollama: "image URLs are not currently supported, please use base64"
  if (isNoloHostedProvider(provider)) return true;
  return provider === "openrouter" && model === "minimax/minimax-m3";
};

const isInlineCandidate = (url: string) =>
  /^https?:\/\//i.test(url) && url.includes(FILE_CONTENT_PATH);

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const defaultFetchImage = async (url: string): Promise<ImageFetchResult> => {
  const response = await fetch(url);
  if (!response.ok) {
    return {
      ok: false,
      error: `HTTP ${response.status}`,
    };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    ok: true,
    mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    bytes,
  };
};

const cloneImagePartWithDataUrl = async (
  part: any,
  fetchImage: (url: string) => Promise<ImageFetchResult>,
) => {
  const url = part?.image_url?.url;
  if (typeof url !== "string" || !isInlineCandidate(url)) return part;

  const result = await fetchImage(url);
  if (!result.ok || !result.bytes) {
    throw new Error(
      `Failed to inline custom provider image URL ${url}: ${result.error ?? "unknown error"}`,
    );
  }

  const mimeType = result.mimeType || "application/octet-stream";
  return {
    ...part,
    image_url: {
      ...part.image_url,
      url: `data:${mimeType};base64,${bytesToBase64(result.bytes)}`,
    },
  };
};

export const inlineImageUrlsForCustomProvider = async <T>(
  bodyData: T,
  options: InlineOptions,
): Promise<T> => {
  if (!options.shouldInline) return bodyData;

  const body: any = bodyData;
  if (!Array.isArray(body?.messages)) return bodyData;

  const fetchImage = options.fetchImage ?? defaultFetchImage;
  let changed = false;
  const messages = [];

  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) {
      messages.push(message);
      continue;
    }

    const content = await Promise.all(
      message.content.map(async (part: any) => {
        if (part?.type !== "image_url") return part;
        return cloneImagePartWithDataUrl(part, fetchImage);
      }),
    );
    let messageChanged = false;
    for (let i = 0; i < content.length; i++) {
      if (content[i] !== message.content[i]) {
        changed = true;
        messageChanged = true;
        break;
      }
    }

    messages.push(messageChanged ? { ...message, content } : message);
  }

  if (!changed) return bodyData;
  return {
    ...body,
    messages,
  };
};
