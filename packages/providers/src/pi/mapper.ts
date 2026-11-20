import { randomUUID } from "node:crypto";
import type { AgentEvent, ErrorInfo, ItemOf, UserInput } from "@codeden/contracts";
import { type AcpToolContext, type AcpToolState, toolCallItem } from "../acp/items";
import { resultContent, toolStateOf } from "./items";
import { PiNotices } from "./notices";
import type { PiAssistantMessage, PiSessionEvent, PiStreamEvent } from "./protocol";
import { contentText, failureOf, stopReasonOf } from "./text";
import { PiTurnUsage } from "./usage";

/** How a CodeDen turn ended: Pi reports each low-level run, `agent_settled` closes the turn. */
export type PiTurnOutcome =
  | { type: "completed"; stopReason?: string }
  | { type: "interrupted"; reason: "user" | "provider" | "runner_restart" }
  | { type: "failed"; error: ErrorInfo };

export interface PiMapperOptions {
  sessionId: string;
  emit: (event: AgentEvent) => void;
  /** The worktree (relative paths resolve against it) and the session's MCP server names. */
  tools: AcpToolContext;
  /** The context window of the model the session runs, for usage. */
  contextWindow?: () => number | undefined;
  /** Called the first time a turn reports another model, so the session can update its own. */
  onModel?: (model: string) => void;
}

/**
 * Translates Pi's session events for one session into normalized `AgentEvent`s (§7.3). A CodeDen
 * turn spans a whole Pi run: the user's message, every assistant response and tool call it takes,
 * and any automatic retry or compaction Pi does along the way. Pi's own `turn_start`/`turn_end`
 * are steps within that, so the turn ends at `agent_settled`, which is when Pi will not continue
 * by itself.
 */
export class PiEventMapper {
  readonly threadId: string;
  private readonly usage: PiTurnUsage;
  private turnId: string | undefined;
  private lastStopReason: string | undefined;
  private failure: ErrorInfo | undefined;
  /** Assistant messages of this turn, numbered so their usage is never added twice. */
  private messageIndex = 0;
  private assistant: ItemOf<"assistant_message"> | undefined;
  private reasoning: ItemOf<"reasoning"> | undefined;
  private readonly calls = new Map<string, AcpToolState>();
  private readonly notices: PiNotices;
  private model: string | undefined;

  constructor(private readonly opts: PiMapperOptions) {
    this.threadId = `${opts.sessionId}:thread-root`;
    this.usage = new PiTurnUsage(opts.contextWindow, () => this.emitUsage());
    this.notices = new PiNotices({
      emit: opts.emit,
      ctx: () => this.ctx(),
      usage: () => this.usage.snapshot(),
      ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
    });
  }

  get currentTurnId(): string | undefined {
    return this.turnId;
  }

  /** Open a turn for a message about to be sent (`send`/`steer` do not; the turn already runs). */
  beginTurn(turnId: string): void {
    this.turnId = turnId;
    this.lastStopReason = undefined;
    this.failure = undefined;
    this.messageIndex = 0;
    this.assistant = undefined;
    this.reasoning = undefined;
    this.usage.reset();
    this.opts.emit({ type: "turn.started", threadId: this.threadId, turnId });
    this.notices.flush();
  }

  /** The user's message, shown as its own item before Pi answers. */
  userMessage(input: UserInput): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const item = {
      id: `user-${randomUUID()}`,
      kind: "user_message" as const,
      status: "completed" as const,
      input,
    };
    this.opts.emit({ type: "item.started", ...ctx, item });
    this.opts.emit({ type: "item.completed", ...ctx, item });
  }

  /** A notice for the current turn, or the next one when no turn is open. */
  notice(level: "info" | "warning", code: string, message: string): void {
    this.notices.notice(level, code, message);
  }

  /** Handle one session event. Events outside a turn (a stray replay) are left out. */
  handle(event: PiSessionEvent): void {
    switch (event.type) {
      case "message_start":
        this.onMessageStart(event.message);
        return;
      case "message_update":
        this.onMessageUpdate(event.assistantMessageEvent);
        return;
      case "message_end":
        this.onMessageEnd(event.message);
        return;
      case "tool_execution_start":
        this.onToolStart(event.toolCallId, event.toolName, event.args ?? {});
        return;
      case "tool_execution_end":
        this.onToolEnd(event.toolCallId, event.result, event.isError, event.durationMs);
        return;
      case "compaction_start":
        this.notices.compactionStart();
        return;
      case "compaction_end":
        this.notices.compactionEnd(
          event.result?.estimatedTokensAfter,
          event.errorMessage,
          event.aborted,
        );
        return;
      case "auto_retry_start":
        this.notice(
          "info",
          "auto_retry",
          `${event.errorMessage ?? "The provider failed"}; retrying (attempt ${event.attempt ?? 1} of ${event.maxAttempts ?? 1})…`,
        );
        return;
      case "agent_settled":
        // The session ends the turn (it knows whether the user interrupted it).
        return;
      default:
        return;
    }
  }

  /**
   * A failed run Pi reported (a stream error, or an assistant message that ended with `error`).
   * The session turns it into the turn's outcome when Pi settles.
   */
  fail(message: string): void {
    if (this.failure) return;
    this.failure = failureOf(message);
  }

  /** End the turn once Pi will not continue, closing anything still open. */
  endTurn(outcome: PiTurnOutcome): void {
    const terminal = outcome.type === "completed" ? undefined : outcome;
    this.closeOpenItems(terminal);
    this.emitUsage();
    const ctx = this.ctx();
    this.turnId = undefined;
    if (!ctx) return;
    this.opts.emit(
      outcome.type === "completed"
        ? {
            type: "turn.completed",
            ...ctx,
            ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
          }
        : outcome.type === "failed"
          ? { type: "turn.failed", ...ctx, error: outcome.error }
          : { type: "turn.interrupted", ...ctx, reason: outcome.reason },
    );
  }

  /** The failure Pi reported in this turn, if any. */
  get turnFailure(): ErrorInfo | undefined {
    return this.failure;
  }

  get stopReason(): string | undefined {
    return this.lastStopReason;
  }

  private onMessageStart(message: { role?: string }): void {
    if (!this.turnId) return;
    if (message.role !== "assistant") return;
    this.messageIndex += 1;
    this.assistant = undefined;
    this.reasoning = undefined;
    void this.openAssistant();
  }

  private openAssistant(): ItemOf<"assistant_message"> | undefined {
    const ctx = this.ctx();
    if (!ctx) return undefined;
    if (this.assistant) return this.assistant;
    const item: ItemOf<"assistant_message"> = {
      id: `assistant-${this.messageIndex}-${randomUUID()}`,
      kind: "assistant_message",
      status: "in_progress",
      text: "",
    };
    this.assistant = item;
    this.opts.emit({ type: "item.started", ...ctx, item });
    return item;
  }

  private onMessageUpdate(update: PiStreamEvent | undefined): void {
    const ctx = this.ctx();
    if (!ctx || !update) return;
    switch (update.type) {
      case "text_delta": {
        const item = this.openAssistant();
        this.lastStopReason = undefined;
        if (item) {
          this.opts.emit({
            type: "item.delta",
            ...ctx,
            itemId: item.id,
            delta: { type: "text", text: update.delta },
          });
        }
        return;
      }
      case "thinking_start": {
        if (!this.reasoning) {
          const item: ItemOf<"reasoning"> = {
            id: `reasoning-${this.messageIndex}-${randomUUID()}`,
            kind: "reasoning",
            status: "in_progress",
            text: "",
          };
          this.reasoning = item;
          this.opts.emit({ type: "item.started", ...ctx, item });
        }
        return;
      }
      case "thinking_delta": {
        if (this.reasoning) {
          this.opts.emit({
            type: "item.delta",
            ...ctx,
            itemId: this.reasoning.id,
            delta: { type: "text", text: update.delta },
          });
        }
        return;
      }
      case "error":
        this.fail(update.error || update.reason || "Pi's model stream ended with an error");
        return;
      default:
        return;
    }
  }

  private onMessageEnd(message: PiAssistantMessage | { role?: string; usage?: unknown }): void {
    if (message.role !== "assistant") return;
    const assistant = message as PiAssistantMessage;
    this.usage.set(this.messageIndex, assistant.usage);
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      if (assistant.errorMessage) this.fail(assistant.errorMessage);
      else if (assistant.stopReason === "error") this.fail("Pi's turn ended with an error");
    } else {
      this.lastStopReason = stopReasonOf(assistant.stopReason);
    }
    this.noteModel(assistant);
    const ctx = this.ctx();
    if (ctx && this.assistant) {
      const item: ItemOf<"assistant_message"> = {
        ...this.assistant,
        status: "completed",
        text: contentText(assistant.content),
      };
      this.opts.emit({ type: "item.completed", ...ctx, item });
      this.assistant = undefined;
    }
    if (ctx && this.reasoning) {
      const item: ItemOf<"reasoning"> = {
        ...this.reasoning,
        status: "completed",
        text: contentText(assistant.content.filter((b) => b.type === "thinking")),
      };
      this.opts.emit({ type: "item.completed", ...ctx, item });
      this.reasoning = undefined;
    }
  }

  private onToolStart(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const state = toolStateOf(
      { toolCallId, toolName, input, cwd: this.opts.tools.cwd },
      this.opts.tools.mcpServers,
    );
    state.startedAt = Date.now();
    this.calls.set(toolCallId, state);
    const item = toolCallItem(state, this.opts.tools, `tool-${toolCallId}`);
    this.opts.emit({ type: "item.started", ...ctx, item });
  }

  private onToolEnd(
    toolCallId: string,
    result: Parameters<typeof resultContent>[0],
    isError: boolean | undefined,
    durationMs: number | undefined,
  ): void {
    const ctx = this.ctx();
    const state = this.calls.get(toolCallId);
    if (!ctx || !state) return;
    state.status = isError ? "failed" : "completed";
    state.content = resultContent(result);
    state.endedAt =
      durationMs !== undefined
        ? (state.startedAt ?? Date.now()) + Math.max(0, durationMs)
        : Date.now();
    const item = toolCallItem(state, this.opts.tools, `tool-${toolCallId}`);
    this.opts.emit({ type: "item.completed", ...ctx, item });
  }

  private noteModel(message: PiAssistantMessage): void {
    const provider = message.provider;
    const id = message.responseModel || message.model;
    if (!provider || !id) return;
    const model = `${provider}/${id}`;
    if (model === this.model) return;
    this.model = model;
    this.opts.emit({ type: "session.updated", model });
    this.opts.onModel?.(model);
  }

  private emitUsage(): void {
    const usage = this.usage.snapshot();
    if (!usage) return;
    this.opts.emit({
      type: "usage.updated",
      threadId: this.threadId,
      ...(this.turnId ? { turnId: this.turnId } : {}),
      usage,
    });
  }

  /** Close what a failing or interrupted turn left open, so every item has an end. */
  private closeOpenItems(terminal: PiTurnOutcome | undefined): void {
    const ctx = this.ctx();
    if (!ctx || !terminal) return;
    const status = terminal.type === "interrupted" ? "cancelled" : "failed";
    if (this.assistant) {
      this.opts.emit({
        type: "item.completed",
        ...ctx,
        item: { ...this.assistant, status },
      });
      this.assistant = undefined;
    }
    if (this.reasoning) {
      this.opts.emit({ type: "item.completed", ...ctx, item: { ...this.reasoning, status } });
      this.reasoning = undefined;
    }
    for (const [id, state] of this.calls) {
      if (state.status === "in_progress") {
        state.status = "failed";
        const item = toolCallItem(state, this.opts.tools, `tool-${id}`);
        this.opts.emit({ type: "item.completed", ...ctx, item: { ...item, status } });
      }
    }
    this.calls.clear();
  }

  private ctx(): { threadId: string; turnId: string } | undefined {
    return this.turnId ? { threadId: this.threadId, turnId: this.turnId } : undefined;
  }
}
