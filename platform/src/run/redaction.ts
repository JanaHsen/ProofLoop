/**
 * Sensitive-value redaction for the run log (Task 4 freeze, decision #3).
 *
 * Detection is STRUCTURAL-FIRST and FAILS SAFE: the primary signal is "the field is
 * a password-type input" (sensitive regardless of label); a name-pattern regex
 * augments it for text-typed sensitive fields (CVV, SSN, card) that type alone won't
 * catch. When either fires, redact.
 *
 * NOTE on the structural signal: whether the @playwright/mcp accessibility snapshot
 * exposes input `type=password` (or the typed value) is confirmed empirically at
 * Task 6. Until then `isPasswordField` is threaded through but unsourced, so the
 * name regex carries the Phase 2 gate flow — whose password field has the accessible
 * name "Password", which the regex catches unambiguously. Wiring the structural
 * signal once Task 6 confirms what the snapshot exposes is a one-line change here.
 *
 * NOTE on `valueLength`: fine for a fixture credential, but a mild length-oracle for
 * real secrets. Bucket it (or drop it) for hosted / Phase 6+ runs.
 */

const SENSITIVE_NAME_RE = /pass(word)?|secret|cvv|card|ssn|otp|token/i;

export interface SensitivitySignal {
  /** Accessible name of the target element, if any. */
  accessibleName?: string;
  /** Structural signal: the target is a password-type input. Sourced at Task 6. */
  isPasswordField?: boolean;
}

export interface RedactedValue {
  value: "[REDACTED]";
  valueLength: number;
  sensitive: true;
}

export function isSensitive(signal: SensitivitySignal): boolean {
  if (signal.isPasswordField) return true; // structural-first
  if (signal.accessibleName && SENSITIVE_NAME_RE.test(signal.accessibleName)) {
    return true; // name-regex augmentation
  }
  return false;
}

/** Redact a typed value to the frozen record shape when the signal says sensitive. */
export function redactValue(
  value: string,
  signal: SensitivitySignal,
): string | RedactedValue {
  return isSensitive(signal)
    ? { value: "[REDACTED]", valueLength: value.length, sensitive: true }
    : value;
}

export function isRedacted(v: unknown): v is RedactedValue {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { sensitive?: unknown }).sensitive === true &&
    (v as { value?: unknown }).value === "[REDACTED]"
  );
}

/**
 * Redact known sensitive values out of stored text (e.g. a snapshot blob that
 * exposes entered values). Replaces every occurrence with the marker. Applied
 * before a snapshot blob is digested + stored so the audit-chain digest matches the
 * stored bytes.
 */
export function redactValuesInText(
  text: string,
  sensitiveValues: readonly string[],
): string {
  let out = text;
  for (const v of sensitiveValues) {
    if (v) out = out.split(v).join("[REDACTED]");
  }
  return out;
}

/**
 * Extract secret literals from flow text — ONLY values adjacent (case-insensitive)
 * to a secret keyword (password | passcode | secret | token). Ordinary quoted values
 * (usernames like "alice", product names, amounts) are deliberately NOT treated as
 * secrets. When a value sits next to a secret keyword we include it (a miss leaks;
 * the run-dir scan test is the backstop). The result seeds the run-scoped mask set
 * BEFORE the first snapshot, so even page-displayed credentials are masked on disk.
 */
const SECRET_LITERAL_RE =
  /\b(?:password|passcode|secret|token)\b[^"\n]*"([^"]+)"/gi;

export function extractSecretLiterals(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    SECRET_LITERAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SECRET_LITERAL_RE.exec(t)) !== null) {
      const v = m[1].trim();
      if (v) out.add(v);
    }
  }
  return [...out];
}
