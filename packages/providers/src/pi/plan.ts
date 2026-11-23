import type { ItemOf } from "@codeden/contracts";

/**
 * What the model is told at the start of every turn in plan mode. Pi has no plan mode of its own,
 * so CodeDen emulates one (§7.2): the gate refuses edits and writing commands, and the first
 * attempt to change something becomes the plan approval the user answers.
 */
export const PLAN_MODE_INSTRUCTIONS =
  "Plan mode is on. Investigate and research as much as you need, but do not edit files and do not " +
  "run commands that change anything: write out the plan you propose in your reply. When it is " +
  "ready, start the first change it calls for: CodeDen asks the user to approve starting there, " +
  "and hands you their answer (or their note) instead of running the change when they decline.";

/** What the model is told when the user declines the plan without a note. */
export const KEEP_PLANNING =
  "The user wants you to keep planning. Revise the plan and present it again.";

/** The plan mode instruction in front of a turn's message. */
export function planPrompt(message: string): string {
  return `<plan-mode>\n${PLAN_MODE_INSTRUCTIONS}\n</plan-mode>\n\n${message}`;
}

/** The plan as the agent wrote it: its latest answer, once it has one. */
export function planOf(lastAnswer: string | undefined): string | undefined {
  const text = lastAnswer?.trim();
  return text ? text : undefined;
}

/** The plan card's item: the agent's own text, shown above the approval. */
export function planItem(planId: string, text: string): ItemOf<"plan"> {
  return { id: planId, kind: "plan", status: "completed", text };
}

/**
 * The approval the user answers while planning: Pi has no plan mode, so the first change the
 * agent tries is its ask to start (`action: "plan"`). Approving lets that call run and turns plan
 * mode off; declining keeps it planning, with the user's note as the reason for the model.
 */
export function planApprovalItem(
  requestId: string,
  init: { toolName?: string; toolCallItemId?: string },
): ItemOf<"approval_request"> {
  return {
    id: `approval-${requestId}`,
    kind: "approval_request",
    status: "in_progress",
    requestId,
    action: "plan",
    title: "Implement the plan",
    reason:
      "Pi is planning. Approving turns plan mode off and runs this change; declining keeps it planning.",
    options: ["allow_once", "deny"],
    ...(init.toolName ? { toolName: init.toolName } : {}),
    ...(init.toolCallItemId ? { toolCallItemId: init.toolCallItemId } : {}),
  };
}
