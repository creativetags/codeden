import { randomUUID } from "node:crypto";
import type { AgentEvent, ItemOf, Usage } from "@codeden/contracts";

/** Where a notice goes: the open turn, if there is one. */
export interface NoticeCtx {
  threadId: string;
  turnId: string;
}

export interface PiNoticesOptions {
  emit: (event: AgentEvent) => void;
  /** The turn a notice sits in, or undefined when no turn is open. */
  ctx: () => NoticeCtx | undefined;
  /** The turn's usage so far, for the context figure a compaction reports. */
  usage: () => Usage | undefined;
  contextWindow?: () => number | undefined;
}

/**
 * The transcript's notices for one session: an automatic retry, an extension that failed, and
 * each compaction as a single notice — opened by "compacting" and completed by its outcome, since
 * a completed item can't change afterwards. A notice that arrives outside a turn (Pi compacting
 * between turns) waits for the next one.
 */
export class PiNotices {
  private readonly pending: Array<{ level: "info" | "warning"; code: string; message: string }> =
    [];
  private compacting: string | undefined;

  constructor(private readonly opts: PiNoticesOptions) {}

  notice(level: "info" | "warning", code: string, message: string): void {
    const ctx = this.opts.ctx();
    if (!ctx) {
      this.pending.push({ level, code, message });
      return;
    }
    const item: ItemOf<"notice"> = {
      id: `notice-${code}-${randomUUID()}`,
      kind: "notice",
      status: "completed",
      level,
      code,
      message,
    };
    this.opts.emit({ type: "item.started", ...ctx, item });
    this.opts.emit({ type: "item.completed", ...ctx, item });
  }

  /** Open a compaction's notice; its outcome completes the same item. */
  compactionStart(): void {
    if (this.compacting) return;
    const ctx = this.opts.ctx();
    if (!ctx) {
      this.pending.push({
        level: "info",
        code: "compacting",
        message: "Compacting the conversation to free up context…",
      });
      return;
    }
    const item: ItemOf<"notice"> = {
      id: `notice-compacting-${randomUUID()}`,
      kind: "notice",
      status: "in_progress",
      level: "info",
      code: "compacting",
      message: "Compacting the conversation to free up context…",
    };
    this.compacting = item.id;
    this.opts.emit({ type: "item.started", ...ctx, item });
  }

  /**
   * Complete the compaction's notice, and report the context it left behind (`Pi`'s own estimate,
   * not a provider-exact count).
   */
  compactionEnd(
    contextTokens: number | undefined,
    errorMessage: string | undefined,
    aborted: boolean | undefined,
  ): void {
    const ctx = this.opts.ctx();
    const id = this.compacting;
    this.compacting = undefined;
    const failed = !!errorMessage;
    const code = failed
      ? "compaction_failed"
      : aborted
        ? "compaction_aborted"
        : "context_compacted";
    const message = failed
      ? `Context compaction failed: ${errorMessage}`
      : aborted
        ? "Context compaction was aborted"
        : "Context compacted";
    if (!ctx) {
      this.pending.push({ level: failed ? "warning" : "info", code, message });
      return;
    }
    const item: ItemOf<"notice"> = {
      id: id ?? `notice-${code}-${randomUUID()}`,
      kind: "notice",
      status: "completed",
      level: failed ? "warning" : "info",
      code,
      message,
    };
    if (!id) this.opts.emit({ type: "item.started", ...ctx, item });
    this.opts.emit({ type: "item.completed", ...ctx, item });
    if (contextTokens === undefined) return;
    const contextWindow = this.opts.contextWindow?.();
    this.opts.emit({
      type: "usage.updated",
      threadId: ctx.threadId,
      usage: {
        ...(this.opts.usage() ?? {}),
        contextTokens,
        ...(contextWindow ? { contextWindow } : {}),
      },
    });
  }

  /** Show the notices that arrived outside a turn. */
  flush(): void {
    if (!this.pending.length) return;
    for (const notice of this.pending.splice(0)) {
      this.notice(notice.level, notice.code, notice.message);
    }
  }
}
