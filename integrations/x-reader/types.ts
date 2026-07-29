export type XBackendName =
  | "desktop_local_browser"
  | "extension_bridge"
  | "oauth_api"
  | "opencli"
  | "public_fallback"
  | "fixture";

export type XReadFailureCode =
  | "not_connected"
  | "not_logged_in"
  | "not_found"
  | "restricted"
  | "suspended_or_deleted"
  | "rate_limited"
  | "network_error"
  | "parse_error"
  | "unsupported_content"
  | "cancelled"
  | "unknown";

export type XAuthor = {
  id?: string;
  handle: string;
  displayName?: string;
  verified?: boolean;
  profileUrl?: string;
};

export type XMedia = {
  type: "image" | "video" | "gif" | "unknown";
  url?: string;
  previewUrl?: string;
  altText?: string;
};

export type XPostSummary = {
  id?: string;
  url?: string;
  authorHandle?: string;
  text?: string;
};

export type XPost = {
  id: string;
  url: string;
  author: XAuthor;
  text: string;
  createdAt?: string;
  media: XMedia[];
  quotedPost?: XPostSummary;
  replyTo?: XPostSummary;
  metrics?: {
    replies?: number;
    reposts?: number;
    likes?: number;
    views?: number;
  };
  sourceBackend: XBackendName;
  fetchedAt: string;
};

export type XThread = {
  root: XPost;
  posts: XPost[];
  completeness: "complete" | "partial" | "single_post" | "unknown";
  missingReason?: XReadFailureCode;
};

export type XReadFailure = {
  ok: false;
  code: XReadFailureCode;
  message: string;
  nextStep?: string;
  backend: XBackendName;
  fetchedAt: string;
};

export type XReadSuccess<T> = {
  ok: true;
  backend: XBackendName;
  fetchedAt: string;
  data: T;
};

export type XReadResult<T> = XReadSuccess<T> | XReadFailure;

export type XReaderBackend = {
  name: XBackendName;
  readPost(url: string): Promise<XReadResult<XPost>>;
  readThread(url: string): Promise<XReadResult<XThread>>;
};

export function createXReadFailure(args: {
  code: XReadFailureCode;
  message: string;
  nextStep?: string;
  backend: XBackendName;
  fetchedAt?: string;
}): XReadFailure {
  return {
    ok: false,
    code: args.code,
    message: args.message,
    nextStep: args.nextStep,
    backend: args.backend,
    fetchedAt: args.fetchedAt ?? new Date().toISOString(),
  };
}
