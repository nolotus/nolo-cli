import { providerCredentialRef, providerSecretKey } from "../../shared/providerSecrets";

export { providerCredentialRef, providerSecretKey } from "../../shared/providerSecrets";

const STORAGE_KEY = "nolo-local-secrets";
const MAX_PROVIDER_SECRET_LENGTH = 16_384;

function isValidProviderSecret(value: string): boolean {
  return value.length > 0 && value.length <= MAX_PROVIDER_SECRET_LENGTH && !/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function readLocalSecrets(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function getLocalProviderSecret(presetId: string): string | null {
  return readLocalSecrets()[providerSecretKey(presetId)] ?? null;
}

export async function getServerProviderSecret(args: {
  serverOrigin: string;
  token: string;
  presetId: string;
}): Promise<string | null> {
  try {
    const response = await fetch(
      `${args.serverOrigin}/api/user-secrets/get?presetId=${encodeURIComponent(args.presetId)}`,
      { cache: "no-store", headers: { Authorization: `Bearer ${args.token}` } },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { value?: string };
    return body.value ?? null;
  } catch {
    return null;
  }
}

export async function saveProviderSecret(args: {
  serverOrigin: string;
  token?: string;
  presetId: string;
  value: string;
  shared: boolean;
}): Promise<boolean> {
  const value = args.value.trim();
  if (!isValidProviderSecret(value)) return false;
  if (!args.shared || !args.token) {
    // Accepted trade-off: localStorage is plaintext; the browser's origin storage is
    // used only as a convenience fallback, while shared secrets use server encryption.
    saveLocalProviderSecret(args.presetId, value);
    return true;
  }
  try {
    const response = await fetch(`${args.serverOrigin}/api/user-secrets/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.token}` },
      body: JSON.stringify({ key: providerSecretKey(args.presetId), value }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function saveLocalProviderSecret(presetId: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  const secrets = readLocalSecrets();
  secrets[providerSecretKey(presetId)] = value;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(secrets));
}
