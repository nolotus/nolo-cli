// XHS Desktop Connector - Read-only types

export type XhsFailureCode =
  | "not_logged_in"
  | "login_required"
  | "blocked"
  | "empty_profile_state"
  | "profile_not_found"
  | "note_not_found"
  | "rate_limited"
  | "network_error"
  | "parse_error"
  | "comment_disabled"
  | "unknown";

export type XhsReadFailure = {
  ok: false;
  code: XhsFailureCode;
  message: string;
  diagnostic?: XhsCollectorDiagnostic;
  fetchedAt: string;
};

export type XhsReadSuccess<T> = {
  ok: true;
  data: T;
  fetchedAt: string;
};

export type XhsReadResult<T> = XhsReadSuccess<T> | XhsReadFailure;

// --- Collector diagnostics (redacted, no secrets) ---

export type XhsCollectorDiagnostic = {
  /** Why the collector returned empty or failed data. */
  code: XhsFailureCode;
  /** Human-readable explanation. */
  message: string;
  /** Page title at the time of collection (may be empty). */
  pageTitle?: string;
  /** Final page URL after navigation (may differ if redirected). */
  finalUrl?: string;
  /** Whether a login wall / prompt was detected on the page. */
  loginDetected?: boolean;
  /** Whether a visible login prompt close button was clicked before declaring the page blocked. */
  loginPromptDismissed?: boolean;
  /** Whether a captcha / verification wall was detected. */
  captchaDetected?: boolean;
  /** Whether __INITIAL_STATE__ was present and non-empty. */
  initialStatePresent?: boolean;
  /** Number of note-like keys found inside __INITIAL_STATE__. */
  initialStateNoteCount?: number;
  /** Number of user_posted API responses captured. */
  capturedApiResponseCount?: number;
  /** HTTP status of the first captured user_posted response (if any). */
  firstApiResponseStatus?: number;
  /** Whether the page URL after navigation looks like a redirect to login. */
  redirectedToLogin?: boolean;
  /** Length of visible body text sampled for diagnostics. */
  bodyTextLength?: number;
  /** Number of visible login close/dismiss candidates found on the page. */
  visibleCloseCandidateCount?: number;
  /** Number of visible XHS note links found on the page. */
  visibleNoteLinkCount?: number;
};

// --- Profile ---

export type XhsProfile = {
  userId: string;
  nickname: string;
  redId?: string;
  avatarUrl?: string;
  desc?: string;
  ipLocation?: string;
  gender?: string; // "male" | "female" | "0" (unknown)
  interactionCounts?: {
    follows?: number;
    fans?: number;
    likesAndCollects?: number;
  };
};

export type XhsNoteSummary = {
  noteId: string;
  title?: string;
  coverUrl?: string;
  type?: "normal" | "video";
  likedCount?: number;
  // kept from initial state / user_posted page
  xsecToken?: string; // internal use only - must not appear in public exports
  xsecSource?: string; // internal navigation hint only - must not appear in public exports
};

// --- Note Detail ---

export type XhsNoteDetail = {
  noteId: string;
  title: string;
  desc: string;
  type: "normal" | "video";
  userId: string;
  nickname: string;
  avatarUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  tagList?: string[];
  ipLocation?: string;
  metrics: {
    likedCount: number;
    collectedCount: number;
    commentCount: number;
    shareCount: number;
  };
  createdAt?: string;
  lastUpdateTime?: string;
};

// --- Comments ---

export type XhsComment = {
  commentId: string;
  userId: string;
  nickname: string;
  avatarUrl?: string;
  content: string;
  likeCount: number;
  subCommentCount: number;
  subComments?: XhsComment[]; // embedded samples only
  ipLocation?: string;
  createdAt?: string;
};

export type XhsCommentPage = {
  comments: XhsComment[];
  hasMore: boolean;
  cursor?: string;
};

// --- Analyzed Result ---

export type XhsTopNote = {
  noteId: string;
  title?: string;
  count: number;
};

export type XhsCommentBucket = {
  label: string;
  count: number;
  sampleCommentIds: string[];
};

export type XhsProfileAnalysis = {
  totalNotes: number;
  highestLikedNote: XhsTopNote | null;
  highestCommentedNote: XhsTopNote | null;
  highestCollectedNote: XhsTopNote | null;
  highestSharedNote: XhsTopNote | null;
  commentBuckets: XhsCommentBucket[];
  topLikedComments: XhsComment[];
};

// --- Collection Status (assisted mode) ---

export type XhsCollectionMode = "conservative" | "assisted";
export type XhsAssistedAction =
  | "snapshot"
  | "read_more_notes"
  | "read_visible_details"
  | "discover_indexed_notes";

export type XhsNextSuggestedAction = {
  action:
    | "read_more_notes"
    | "read_visible_details"
    | "discover_indexed_notes"
    | "save_to_table"
    | "stop_anonymous_unavailable";
  label: string;
  reason: string;
};

export type XhsCollectionStatus = {
  mode: XhsCollectionMode;
  action: XhsAssistedAction;
  extendedCollectionConsent: boolean;
  assistedStepCount: number;
  limits: {
    maxAssistedSteps: number;
    maxScrollPages: number;
    maxCommentPagesPerNote: number;
    includeComments: boolean;
  };
  nextSuggestedAction?: XhsNextSuggestedAction;
};

// --- Full collection result ---

export type XhsProfileCollection = {
  profile: XhsProfile;
  notes: XhsNoteSummary[];
  noteDetails: XhsNoteDetail[];
  commentsByNote: Record<string, XhsComment[]>;
  analysis: XhsProfileAnalysis;
  indexedDiscovery?: {
    source: "external_index";
    requestedNoteUrls: string[];
    acceptedNoteUrls: string[];
    verifiedNoteUrls: string[];
  };
  /** Present only when the collector detected an issue. Never contains secrets. */
  diagnostic?: XhsCollectorDiagnostic;
  /** Collection status for assisted automation mode. */
  collectionStatus?: XhsCollectionStatus;
};

// --- URL parsing result ---

export type XhsParsedProfileUrl = {
  userId: string;
  canonicalUrl: string;
  navigationUrl: string;
  xsecToken?: string; // preserved internally only
  xsecSource?: string; // preserved internally only
};

export type XhsParsedNoteUrl = {
  noteId: string;
  canonicalUrl: string;
  xsecToken?: string; // preserved internally only
  xsecSource?: string; // preserved internally only
};

// --- Redaction ---

export type XhsConnectorOptions = {
  profileUrl: string;
  maxScrollPages?: number; // default 0
  enrichDetails?: boolean; // default false
  includeComments?: boolean; // default false
  maxCommentPagesPerNote?: number; // default 1
  headless?: boolean; // default false
  cookieDir?: string;
  fetchImpl?: typeof fetch;
  /** Assisted mode: "conservative" (default) or "assisted" */
  collectionMode?: XhsCollectionMode;
  /** Which action to perform in assisted mode */
  assistedAction?: XhsAssistedAction;
  /** Max assisted steps (1..3), bounds scroll/comment pages */
  maxAssistedSteps?: number;
  /** Public note URLs discovered from an external search index. */
  indexedNoteUrls?: string[];
};

// Helper to create failure
export function createXhsFailure(args: {
  code: XhsFailureCode;
  message: string;
  diagnostic?: XhsCollectorDiagnostic;
}): XhsReadFailure {
  return {
    ok: false,
    code: args.code,
    message: args.message,
    ...(args.diagnostic ? { diagnostic: args.diagnostic } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export function createXhsSuccess<T>(data: T): XhsReadSuccess<T> {
  return {
    ok: true,
    data,
    fetchedAt: new Date().toISOString(),
  };
}
