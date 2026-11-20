import { decideToolCall, type PiApprovalDeps } from "./approvals";
import { type PiApprovalAnswer, parseApprovalRequest } from "./extension";
import type { PiExtensionUiRequest } from "./protocol";

/** What to send back for one extension dialog. */
export type PiDialogReply = { answer: PiApprovalAnswer } | { cancelled: true };

/** The dialog methods that wait for an answer; the rest are fire-and-forget. */
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/**
 * One `extension_ui_request`, answered (§11.2). CodeDen's gate asks about a tool call with an
 * `input` dialog carrying the call, and the session's policy decides it; any other dialog (an
 * extension of the user's that CodeDen has no UI for) is cancelled. Returns undefined for the
 * calls that expect no answer (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`).
 */
export async function replyToDialog(
  request: PiExtensionUiRequest,
  deps: PiApprovalDeps,
): Promise<PiDialogReply | undefined> {
  if (request.method !== "input") {
    return DIALOGS.has(request.method) ? { cancelled: true } : undefined;
  }
  const call = parseApprovalRequest(request.title);
  if (!call) return { cancelled: true };
  try {
    const answer = await decideToolCall({ ...call, cwd: call.cwd ?? deps.cwd }, deps);
    return { answer };
  } catch (error) {
    // Fail-safe: a decision CodeDen can't make blocks the call.
    return {
      answer: {
        decision: "deny",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
