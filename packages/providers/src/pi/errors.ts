import type { ErrorInfo, ErrorKind } from "@codeden/contracts";

/**
 * A full context window, in the shapes model providers report it. Pi hands the provider's own
 * message through, and its own overflow detection knows these (`pi-ai`'s overflow patterns).
 */
const CONTEXT = [
  /prompt (?:is )?too long/i,
  /request_too_large/i,
  /\b413\b/,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /maximum context length is [\d,]+ tokens/i,
  /context window exceeded|context window exceeds limit/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /exceeds the maximum allowed input length of [\d,]+ tokens?/i,
  /exceeded model token limit/i,
  /too large for model with [\d,]+ maximum context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
];

/** A sign-in or credential problem: no key for the provider, an expired login. */
const AUTH = [
  /\bno api key\b/i,
  /invalid api key|invalid_api_key/i,
  /\bunauthori[sz]ed\b|\b401\b|\b403\b|\bforbidden\b/i,
  /not logged in|log ?in required|sign ?in required|please log ?in/i,
  /credential|oauth token|token refresh/i,
];

/** The account's own allowance ran out (a rate limit, a quota, a billing stop). */
const LIMIT = [
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /usage limit/i,
  /out of (?:budget|credits)/i,
  /insufficient_quota|billing/i,
];

/** Trouble worth another turn: an overloaded provider, a dropped stream, a timeout. */
const TRANSIENT = [
  /overloaded/i,
  /servers? (?:is|are) (?:currently )?(?:busy|unavailable)/i,
  /currently experiencing high demand/i,
  /at capacity/i,
  /\b(?:500|502|503|504|520|524)\b/,
  /temporarily unavailable/i,
  /server.?error|internal.?error/i,
  /provider returned (?:an )?error/i,
  /ended without|stream (?:was )?interrupted|stream disconnected/i,
  /socket hang up|other side closed|reset before headers/i,
  /fetch failed|network.?error|connection (?:error|refused|lost)/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/i,
  /timed? ?out|timeout/i,
];

/**
 * Classify a failed Pi turn from its text (§7.3 `ErrorInfo.kind`). Pi reports failures as
 * messages (its assistant message's `errorMessage`, or a refused command), so the classification
 * reads that text: a full context window, a sign-in problem, an exhausted allowance, transient
 * trouble, and anything else is fatal.
 */
export function classifyPiError(message: string): ErrorKind {
  if (AUTH.some((pattern) => pattern.test(message))) return "auth";
  if (CONTEXT.some((pattern) => pattern.test(message))) return "context_full";
  if (LIMIT.some((pattern) => pattern.test(message))) return "usage_limit";
  if (TRANSIENT.some((pattern) => pattern.test(message))) return "transient";
  return "fatal";
}

/** A failed turn as its error item's payload: the text, and whether another turn may help. */
export function piErrorInfo(message: string, code = "turn_failed"): ErrorInfo {
  const kind = classifyPiError(message);
  return {
    code,
    message,
    kind,
    retryable: kind === "transient" || kind === "usage_limit",
  };
}

/** The message of an error Pi refused a command with. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
