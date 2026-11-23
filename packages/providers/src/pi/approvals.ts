import type { ItemOf } from "@codeden/contracts";
import { approvalItem } from "../acp/approvals";
import { type AcpPolicy, PLAN_EDIT_DENIAL } from "../acp/policy";
import type { ApprovalBroker, ItemCtx } from "../approvals";
import type { PiApprovalAnswer } from "./extension";
import { mcpTarget, type PiToolCall, toolStateOf } from "./items";
import { KEEP_PLANNING, planApprovalItem, planItem, planOf } from "./plan";

export interface PiApprovalDeps {
  broker: ApprovalBroker;
  policy: AcpPolicy;
  /** The worktree, for the card's paths and the policy's judgement. */
  cwd: string;
  mcpServers: readonly string[];
  /** CodeDen's own MCP servers, whose tools run without asking. */
  trustedServers: readonly string[];
  /** The turn the call belongs to; absent means nothing can wait for an answer. */
  ctx: ItemCtx | undefined;
  /** A notice for the transcript, for what an extension of the user's reports (`notify`). */
  notify: (level: "info" | "warning", message: string) => void;
  /** The agent's latest answer, the plan a plan-mode approval shows. */
  plan?: () => string | undefined;
  /** Show the plan on the plan card (the agent's own latest answer). */
  emitPlan?: (item: ItemOf<"plan">) => void;
  /** The user approved planning's end: plan mode off and the change may run. */
  approvePlan?: () => void;
}

const ALLOW: PiApprovalAnswer = { decision: "allow_once" };

/**
 * Decide one tool call Pi's gate reports (§11.2). Pi has no permission system of its own: the gate
 * (`./extension`) sends every call to CodeDen before it runs, and this applies the same classifier
 * and levels as the other providers, so a level change reaches the next call. Approved calls show
 * in the transcript as decided by the policy; a call that needs the user becomes an
 * `approval_request` and the gate waits for `respond`. A denial's reason goes back to Pi, which
 * hands it to the model instead of running the tool.
 */
export async function decideToolCall(
  call: PiToolCall,
  deps: PiApprovalDeps,
): Promise<PiApprovalAnswer> {
  const state = toolStateOf(call, deps.mcpServers);
  const decision = deps.policy.decide(state);
  const item = approvalItem(state, decision, deps, `tool-${call.toolCallId}`);
  if (decision.kind === "allow") {
    if (deps.ctx && !isTrustedCall(call, deps)) {
      deps.broker.record(deps.ctx, {
        ...item,
        status: "completed",
        reason: `Allowed by the ${levelName(deps.policy.level)} permission level`,
        decision: "allow_once",
        decidedBy: "policy",
      });
    }
    return ALLOW;
  }
  if (decision.kind === "deny" && decision.plan && deps.ctx) {
    // Pi has no plan mode: the first change it tries while planning is its ask to start.
    return askPlan(state, deps);
  }
  if (decision.kind === "deny") {
    if (deps.ctx) {
      deps.broker.record(deps.ctx, {
        ...item,
        status: "declined",
        reason: decision.message,
        decision: "deny",
        decidedBy: "policy",
      });
    }
    return { decision: "deny", reason: decision.message };
  }
  if (!deps.ctx) {
    return { decision: "deny", reason: "No turn is running to answer the approval request" };
  }
  const response = await deps.broker.request(deps.ctx, item);
  if (response.kind === "approval" && response.decision !== "deny") {
    if (response.decision === "allow_session") deps.policy.allowForSession(state);
    return ALLOW;
  }
  if (response.kind === "approval") {
    return {
      decision: "deny",
      reason: response.message || "The user declined this tool call",
    };
  }
  return { decision: "deny", reason: "The session is stopping" };
}

/**
 * The plan approval (§7.2): the agent tried to change something while planning, so the user
 * decides whether it starts. The agent's own latest answer is the plan on the card. Approving
 * turns plan mode off and lets this call run; declining keeps it planning and hands the model the
 * reason (the user's note, when they wrote one).
 */
async function askPlan(
  state: ReturnType<typeof toolStateOf>,
  deps: PiApprovalDeps,
): Promise<PiApprovalAnswer> {
  const ctx = deps.ctx;
  if (!ctx) return { decision: "deny", reason: PLAN_EDIT_DENIAL };
  const requestId = `plan-${state.toolCallId}`;
  const plan = planOf(deps.plan?.());
  if (plan) deps.emitPlan?.(planItem(`plan-${state.toolCallId}`, plan));
  const response = await deps.broker.request(
    ctx,
    planApprovalItem(requestId, {
      ...(state.name ? { toolName: state.name } : {}),
      toolCallItemId: `tool-${state.toolCallId}`,
    }),
  );
  if (response.kind === "approval" && response.decision !== "deny") {
    deps.approvePlan?.();
    return ALLOW;
  }
  if (response.kind === "approval") {
    return { decision: "deny", reason: response.message?.trim() || KEEP_PLANNING };
  }
  return { decision: "deny", reason: "The session is stopping" };
}

/** A trusted call: a tool of CodeDen's own MCP server, recognised by the name Pi assigned. */
function isTrustedCall(call: PiToolCall, deps: PiApprovalDeps): boolean {
  const mcp = mcpTarget(call.toolName, deps.mcpServers);
  return mcp !== undefined && deps.trustedServers.includes(mcp.server);
}

function levelName(level: string): string {
  if (level === "full") return "Full";
  if (level === "supervised") return "Supervised";
  return level === "read_only" ? "Read-only" : "Auto";
}
