import type { ErrorInfo } from "@codeden/contracts";
import { classifyAcpError } from "../acp/errors";

/** The text of Pi's content blocks (images and tool calls are not text). */
export function contentText(
  content: { type: string; text?: string; thinking?: string }[] | undefined,
): string {
  return (content ?? [])
    .map((block) =>
      block.type === "text"
        ? (block.text ?? "")
        : block.type === "thinking"
          ? (block.thinking ?? "")
          : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Pi's stop reasons as CodeDen's common vocabulary (`end_turn`, `max_tokens`, `tool_use`). */
export function stopReasonOf(reason: string | undefined): string | undefined {
  switch (reason) {
    case undefined:
      return undefined;
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "toolUse":
      return "tool_use";
    case "aborted":
      return "cancelled";
    default:
      return reason;
  }
}

/**
 * A failed run as the turn's error (§7.3). Pi reports failures as text (its assistant message's
 * `errorMessage`, or the stream's error), so the classification reads that text.
 */
export function failureOf(message: string): ErrorInfo {
  const kind = classifyAcpError(new Error(message));
  return {
    code: "turn_failed",
    message,
    kind,
    retryable: kind === "transient" || kind === "usage_limit",
  };
}
