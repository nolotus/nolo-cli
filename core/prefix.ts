const extractKeyPart = (key: string, index: number): string => {
  const parts = key.split("-");
  if (index < 2) {
    return parts[index];
  }
  return parts.slice(index).join("-");
};

export const extractUserId = (key: string): string => {
  const parts = key.split("-");

  if (parts.length === 2) {
    return parts[0];
  }

  if (parts[0] === "user" && parts[1] === "pref" && parts.length >= 3) {
    return parts[2];
  }

  return extractKeyPart(key, 1);
};

export const extractCustomId = (key: string): string => extractKeyPart(key, 2);
