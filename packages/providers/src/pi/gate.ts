import type { UserQuestion } from "@codeden/contracts";
import { shorten } from "../util/text";
import { decideToolCall, type PiApprovalDeps } from "./approvals";
import { type PiApprovalAnswer, parseApprovalRequest } from "./extension";
import type { PiExtensionUiRequest } from "./protocol";

/**
 * What to send back for one extension dialog: the fields of `PiExtensionUiResponse` it carries
 * (`value` for select/input/editor, `confirmed` for confirm, `cancelled` for a dismissal).
 */
export type PiDialogReply = { value?: string; confirmed?: boolean; cancelled?: boolean };

/** The dialog methods that wait for an answer; the rest are fire-and-forget. */
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

const YES = "Yes";
const NO = "No";

/**
 * One `extension_ui_request`, answered (§11.2). CodeDen's gate asks about a tool call with an
 * `input` dialog carrying the call, and the session's policy decides it. Every other dialog comes
 * from an extension of the user's, so it reaches the user as a `user_question`, and a `notify`
 * becomes a notice in the transcript. Returns undefined for the calls that expect no answer
 * (`setStatus`, `setWidget`, `setTitle`, `set_editor_text`).
 */
export async function replyToDialog(
  request: PiExtensionUiRequest,
  deps: PiApprovalDeps,
): Promise<PiDialogReply | undefined> {
  if (request.method === "notify") {
    deps.notify(
      request.notifyType === "info" ? "info" : "warning",
      request.message ?? request.title ?? "Pi extension notice",
    );
    return undefined;
  }
  if (!DIALOGS.has(request.method)) return undefined;
  if (request.method === "input") {
    const call = parseApprovalRequest(request.title);
    if (call) return { value: JSON.stringify(await decide(call, deps)) };
  }
  return askUser(request, deps);
}

/** The gate's answer for one tool call: the policy's own, or a refusal when it can't decide. */
async function decide(
  call: NonNullable<ReturnType<typeof parseApprovalRequest>>,
  deps: PiApprovalDeps,
): Promise<PiApprovalAnswer> {
  try {
    return await decideToolCall({ ...call, cwd: call.cwd ?? deps.cwd }, deps);
  } catch (error) {
    // Fail-safe: a decision CodeDen can't make blocks the call.
    return {
      decision: "deny",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A dialog from one of the user's own extensions: it shows as a `user_question`, and the answer
 * goes back in the shape Pi expects for that dialog. Dismissed (or asked with no turn running)
 * it is cancelled, which Pi's extension sees as `undefined`/`false`.
 */
async function askUser(
  request: PiExtensionUiRequest,
  deps: PiApprovalDeps,
): Promise<PiDialogReply> {
  const ctx = deps.ctx;
  if (!ctx) return { cancelled: true };
  const question = questionOf(request);
  const response = await deps.broker.request(ctx, {
    id: `question-ext-${request.id}`,
    kind: "user_question",
    status: "in_progress",
    requestId: `ext-${request.id}`,
    questions: [question],
  });
  if (response.kind !== "answer") return { cancelled: true };
  const answer = (response.answers[question.id] ?? []).join(", ");
  if (request.method === "confirm")
    return { confirmed: answer.trim().toLowerCase() === YES.toLowerCase() };
  return { value: answer };
}

/** One extension dialog as a CodeDen question, with the type of answer it takes. */
export function questionOf(request: PiExtensionUiRequest): UserQuestion {
  const title = (request.title ?? "").trim();
  const message = (request.message ?? "").trim();
  const text = message || title || "Pi extension";
  switch (request.method) {
    case "select": {
      const options = (request.options ?? []).map((label) => ({ label: shorten(label, 200) }));
      return {
        id: "answer",
        ...(title ? { header: shorten(title, 40) } : {}),
        question: text,
        options,
        multiSelect: false,
        allowFreeText: false,
      };
    }
    case "confirm":
      return {
        id: "answer",
        ...(title ? { header: shorten(title, 40) } : {}),
        question: text,
        options: [{ label: YES }, { label: NO }],
        multiSelect: false,
        allowFreeText: false,
      };
    default:
      return {
        id: "answer",
        ...(title ? { header: shorten(title, 40) } : {}),
        question: text,
        options: [],
        multiSelect: false,
        allowFreeText: true,
      };
  }
}
