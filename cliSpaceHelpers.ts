export function normalizeSpaceIdInput(rawInput: string) {
  const raw = rawInput.trim();
  if (!raw) return "";

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const url = new URL(raw);
    const match = url.pathname.match(/^\/space\/([^/?#]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }

  return raw.startsWith("space-") ? raw.slice("space-".length) : raw;
}

export function buildSpaceLookup(rawInput: string) {
  const spaceId = normalizeSpaceIdInput(rawInput);
  return {
    spaceId,
    spaceKey: spaceId.startsWith("space-") ? spaceId : `space-${spaceId}`,
  };
}

export function getSpaceContentKeys(spaceRecord: any): Set<string> {
  const keys = new Set<string>();
  const contents = spaceRecord?.contents;
  if (!contents || typeof contents !== "object") return keys;

  for (const [entryKey, value] of Object.entries(contents)) {
    if (typeof entryKey === "string" && entryKey.trim()) {
      keys.add(entryKey.trim());
    }
    if (value && typeof value === "object") {
      const contentKey = (value as any).contentKey;
      if (typeof contentKey === "string" && contentKey.trim()) {
        keys.add(contentKey.trim());
      }
    }
  }
  return keys;
}
