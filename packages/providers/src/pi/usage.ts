import type { Usage } from "@codeden/contracts";
import type { PiUsage } from "./protocol";

/**
 * Token and cost accounting for one turn. Pi reports each assistant message's own usage when that
 * message ends (never a running total), so a turn's usage is the sum over its messages. Pi's
 * `output` already includes reasoning; `input` already excludes cache reads and writes.
 */
export class PiTurnUsage {
  private readonly messages = new Map<number, PiUsage>();

  constructor(
    private readonly contextWindow: (() => number | undefined) | undefined,
    /** Called when the turn's usage grew, so the session can emit `usage.updated`. */
    private readonly onReport: (() => void) | undefined = undefined,
  ) {}

  /** Record (or replace) one assistant message's usage. */
  set(message: number, usage: PiUsage | undefined): void {
    if (!usage) return;
    this.messages.set(message, usage);
    this.onReport?.();
  }

  reset(): void {
    this.messages.clear();
  }

  /** The turn's usage so far, or undefined when Pi reported none yet. */
  snapshot(): Usage | undefined {
    if (!this.messages.size) return undefined;
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let context: number | undefined;
    for (const usage of this.messages.values()) {
      input += count(usage.input);
      output += count(usage.output);
      reasoning += count(usage.reasoning);
      cacheRead += count(usage.cacheRead);
      cacheWrite += count(usage.cacheWrite);
      cost += Math.max(0, usage.cost?.total ?? 0);
      // What occupies the context window: this call's input and output, with its cache traffic.
      if (usage.input !== undefined) {
        context =
          count(usage.input) +
          count(usage.cacheRead) +
          count(usage.cacheWrite) +
          count(usage.output);
      }
    }
    const window = this.contextWindow?.();
    return {
      inputTokens: input,
      // CodeDen's outputTokens include reasoning (Pi's do too, unless a provider splits them out).
      outputTokens: output + reasoning,
      cachedInputTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      ...(reasoning ? { reasoningTokens: reasoning } : {}),
      ...(context !== undefined ? { contextTokens: context } : {}),
      ...(window ? { contextWindow: window } : {}),
      // Left out when Pi reported no cost, so the usage ledger can price the model itself.
      ...(cost > 0 ? { costUsd: Math.round(cost * 1e8) / 1e8 } : {}),
    };
  }
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
