import { normalizeSpaceId } from "../../create/space/spaceKeys";
import { BUILTIN_APP_BUILDER_AGENT_KEY } from "../../core/builtinAgents";
import { normalizeServerOrigin } from "../../core/serverOrigin";

export const APP_BUILDER_PUBLIC_AGENT_KEY = BUILTIN_APP_BUILDER_AGENT_KEY;

const APP_SERVER_SEARCH_PARAM = "server";
export const APP_EDIT_MODE_SEARCH_PARAM = "mode";

const normalizeAppServerOrigin = (serverOrigin?: string | null): string | null => {
  const normalized = normalizeServerOrigin(serverOrigin);
  return normalized || null;
};

const withAppQuery = (
  path: string,
  query: Record<string, string | undefined>,
  serverOrigin?: string | null
): string => {
  const url = new URL(path, "https://nolo.local");
  for (const [key, value] of Object.entries(query)) {
    if (!value) continue;
    url.searchParams.set(key, value);
  }
  const normalizedServerOrigin = normalizeAppServerOrigin(serverOrigin);
  if (normalizedServerOrigin) {
    url.searchParams.set(APP_SERVER_SEARCH_PARAM, normalizedServerOrigin);
  }
  return `${url.pathname}${url.search}${url.hash}`;
};

export const readAppServerOrigin = (
  search: URLSearchParams | string | null | undefined
): string | undefined => {
  if (!search) return undefined;
  const params =
    typeof search === "string"
      ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
      : search;
  return normalizeAppServerOrigin(params.get(APP_SERVER_SEARCH_PARAM)) ?? undefined;
};

const buildAppBasePath = (appKey: string, spaceId?: string | null) => {
  if (!spaceId) return `/${appKey}`;
  return `/space/${normalizeSpaceId(spaceId)}/${appKey}`;
};

export const buildAppDetailPath = (
  appKey: string,
  spaceId?: string | null,
  serverOrigin?: string | null
) => withAppQuery(buildAppBasePath(appKey, spaceId), {}, serverOrigin);

export const buildAppEditorPath = (
  appKey: string,
  spaceId?: string | null,
  serverOrigin?: string | null
) =>
  withAppQuery(
    buildAppBasePath(appKey, spaceId),
    {
      edit: "true",
    },
    serverOrigin
  );

export const buildAppChatEditorPath = (
  appKey: string,
  spaceId?: string | null,
  serverOrigin?: string | null
) =>
  withAppQuery(
    buildAppBasePath(appKey, spaceId),
    {
      edit: "true",
      [APP_EDIT_MODE_SEARCH_PARAM]: "chat",
    },
    serverOrigin
  );

export const buildAppCodeEditorPath = (
  appKey: string,
  spaceId?: string | null,
  serverOrigin?: string | null
) =>
  withAppQuery(
    buildAppBasePath(appKey, spaceId),
    {
      edit: "true",
      [APP_EDIT_MODE_SEARCH_PARAM]: "code",
    },
    serverOrigin
  );

export const buildAppAssistantSidebarId = (appKey: string) =>
  `objectAssistant:app:${appKey}`;
