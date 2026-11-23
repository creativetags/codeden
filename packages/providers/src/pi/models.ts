import type { ModelInfo, ReasoningEffort } from "@codeden/contracts";
import { ReasoningEffort as ReasoningEffortSchema } from "@codeden/contracts";
import { DEFAULT_MODEL_ID } from "../util/model";
import type { PiModel } from "./protocol";

const CONFIGURED_MODEL =
  "The model configured in Pi (its settings and credentials), or Pi's own default";

/** Pi's model id as CodeDen uses it: `<provider>/<model>`, the form `pi --model` accepts. */
export function modelId(m: Pick<PiModel, "id" | "provider">): string {
  return `${m.provider}/${m.id}`;
}

/** Split a CodeDen model id back into what `set_model` takes. */
export function splitModelId(id: string): { provider: string; modelId: string } {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return { provider: "", modelId: id };
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

/**
 * Until Pi has listed its models, one entry that leaves the choice to the user's Pi config.
 * `note` says why the real list is missing when discovery failed.
 */
export function fallbackPiModels(note?: string): ModelInfo[] {
  return [
    {
      id: DEFAULT_MODEL_ID,
      label: "Default",
      description: note ? `${CONFIGURED_MODEL}. ${note}` : CONFIGURED_MODEL,
      efforts: [],
      isDefault: true,
    },
  ];
}

/**
 * The thinking levels a model supports, as CodeDen efforts. Pi names them `off`, `minimal`, `low`,
 * `medium`, `high`, `xhigh` and `max`, and its `thinkingLevelMap` gives the provider value each
 * one maps to (`null` where the model has no such level).
 */
export function effortsOf(m: Pick<PiModel, "reasoning" | "thinkingLevelMap">): ReasoningEffort[] {
  if (m.reasoning === false) return [];
  const map = m.thinkingLevelMap;
  if (!map) return [...ReasoningEffortSchema.options];
  const supported = new Set(
    Object.entries(map)
      .filter(([, value]) => value !== null)
      .map(([level]) => level),
  );
  return ReasoningEffortSchema.options.filter((effort) => supported.has(effort));
}

/**
 * Map a Pi model to CodeDen's `ModelInfo`. The description names Pi's provider, since one Pi
 * install can list the same model through several providers.
 */
export function modelInfoFromPi(m: PiModel, isDefault = false): ModelInfo {
  const context = m.contextWindow;
  return {
    id: modelId(m),
    label: m.name || m.id,
    description: m.provider,
    efforts: effortsOf(m),
    ...(isDefault ? { isDefault: true } : {}),
    ...(context && Number.isInteger(context) && context > 0 ? { contextWindow: context } : {}),
  };
}

/**
 * Every usable model as `ModelInfo`: the current default first, then the rest in Pi's own order.
 * Duplicate ids keep their first entry.
 */
export function piModelList(models: readonly PiModel[], defaultModel?: PiModel): ModelInfo[] {
  const defaultId = defaultModel ? modelId(defaultModel) : undefined;
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  const ordered = defaultModel
    ? [defaultModel, ...models.filter((m) => modelId(m) !== defaultId)]
    : [...models];
  for (const model of ordered) {
    if (!model.id || !model.provider) continue;
    const id = modelId(model);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(modelInfoFromPi(model, id === defaultId));
  }
  return out;
}

/** True when a model takes image input (`input: ["text", "image"]`). */
export function modelTakesImages(m: PiModel | undefined): boolean {
  return m?.input?.includes("image") === true;
}
