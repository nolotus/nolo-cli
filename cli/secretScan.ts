export type SecretFinding = {
  label: string;
  line: number;
  preview: string;
};

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "password", pattern: /\bpassword\s*[:=]\s*["']?[^"',\s#]{8,}/i },
  { label: "psk", pattern: /\bpsk\s*[:=]\s*["']?[^"',\s#]{8,}/i },
  { label: "api key", pattern: /\b(api[_-]?key|apikey)\s*[:=]\s*["']?[^"',\s#]{12,}/i },
  { label: "token", pattern: /\b(token|secret)\s*[:=]\s*["']?[^"',\s#]{12,}/i },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export function findPotentialSecrets(text: string): SecretFinding[] {
  return text
    .split(/\r?\n/)
    .flatMap((line, index) =>
      SECRET_PATTERNS.filter(({ pattern }) => pattern.test(line)).map(({ label }) => ({
        label,
        line: index + 1,
        preview: line.length > 120 ? `${line.slice(0, 117)}...` : line,
      }))
    );
}

export function formatSecretFindings(findings: SecretFinding[]) {
  return findings
    .map((finding) => `  line ${finding.line} (${finding.label}): ${finding.preview}`)
    .join("\n");
}
