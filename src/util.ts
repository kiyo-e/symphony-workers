export function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

export function truncate(value: string | undefined, max = 8_000): string | undefined {
  if (!value) return value;
  return value.length <= max ? value : `${value.slice(0, max)}\n…<truncated>`;
}

export function safeId(value: string, max = 40): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return normalized || "job";
}

export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function sandboxId(projectKey: string, issueId: string, identifier: string): string {
  const prefix = safeId(`${projectKey}-${identifier}`, 44);
  return `sym-${prefix}-${fnv1a(issueId)}`.slice(0, 63);
}

export function runId(identifier: string, turn: number, attempt: number): string {
  return safeId(`${identifier}-t${turn}-a${attempt}-${Date.now().toString(36)}`, 62);
}

export function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
