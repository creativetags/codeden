import type { SessionConfigChange } from "../adapter";
import { splitModelId } from "./models";
import type { PiModel } from "./protocol";
import type { PiRpc } from "./rpc";

/** What a model/effort switch reports back to the session. */
export interface PiChangeTarget {
  /** The model Pi reports after a switch (its actual selection). */
  onModel: (model: PiModel) => void;
  /** A warning for the transcript when a switch fails. */
  onFailure: (code: string, message: string) => void;
}

/**
 * A pending `session.configure` change, applied between turns: Pi sets its model and thinking
 * level for the next prompt, never in the middle of one. A refusal is a warning in the
 * transcript, not a failed turn: the session continues on the model it had.
 */
export class PiChange {
  private model: string | null | undefined;
  private effort: string | null | undefined;

  /** Record a change; it reaches Pi at the next `send`. */
  set(change: SessionConfigChange): void {
    if (change.model !== undefined) this.model = change.model;
    if (change.effort !== undefined) this.effort = change.effort;
  }

  /** Apply what was recorded, if anything. */
  async apply(rpc: PiRpc, target: PiChangeTarget): Promise<void> {
    if (this.model !== undefined) {
      const wanted = this.model;
      this.model = undefined;
      const split = wanted ? splitModelId(wanted) : undefined;
      if (split?.provider) {
        await rpc
          .request<PiModel>({ type: "set_model", provider: split.provider, modelId: split.modelId })
          .then((model) => target.onModel(model))
          .catch((error) => target.onFailure("model_switch_failed", messageOf(error)));
      }
    }
    if (this.effort !== undefined) {
      const effort = this.effort;
      this.effort = undefined;
      if (effort) {
        await rpc
          .request({ type: "set_thinking_level", level: effort })
          .catch((error) => target.onFailure("effort_switch_failed", messageOf(error)));
      }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
