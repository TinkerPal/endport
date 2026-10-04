const MAX_BODY = 8 * 1024;
const secretKey = /password|passwd|pwd|token|secret|authorization|auth|cookie|api[-_]?key|private|credential|session|card|cvv|cvc|pin|ssn|email|phone|address/i;
const secretValue = /^(?:Bearer\s+\S+|sk_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[a-fA-F0-9]{32,}|[A-Za-z0-9_-]{48,})$/;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[OMITTED]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(item, depth + 1)]));
  }
  if (typeof value === 'string') return value.length > 256 || secretValue.test(value.trim()) ? '[REDACTED]' : value;
  return value;
}

export function jsonPreview(bytes: Buffer, contentType: string | string[] | undefined): unknown | null {
  const type = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!type?.toLowerCase().includes('application/json') || bytes.length === 0 || bytes.length > MAX_BODY) return null;
  try {
    const sanitized = redact(JSON.parse(bytes.toString('utf8')));
    return JSON.stringify(sanitized).length <= MAX_BODY ? sanitized : null;
  } catch { return null; }
}
