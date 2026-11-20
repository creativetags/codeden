/** Pi coding agent: its RPC mode behind CodeDen's adapter, with the gate extension it needs. */
export { PiAdapter, type PiAdapterOptions } from "./adapter";
export {
  detectPi,
  isSupportedPiVersion,
  PI_INSTALL_COMMAND,
  PI_MIN_VERSION,
  PI_PROVIDER_ID,
  PI_UPGRADE_COMMAND,
  type PiAuth,
  type PiDetectOptions,
  piAgentDir,
  piTooOldMessage,
  readPiAuth,
  readPiDefaultModel,
} from "./detect";
export {
  GATE_STATUS_KEY,
  gateExtensionSource,
  type PiApprovalAnswer,
  type PiApprovalRequest,
  parseApprovalRequest,
  writeGateExtension,
} from "./extension";
export { mcpTarget, type PiToolCall, resultContent, toolStateOf } from "./items";
export { PiEventMapper, type PiMapperOptions, type PiTurnOutcome } from "./mapper";
export {
  effortsOf,
  fallbackPiModels,
  modelId,
  modelInfoFromPi,
  modelTakesImages,
  piModelList,
  splitModelId,
} from "./models";
export { PiProcess, type PiProcessCallbacks, type PiProcessConfig } from "./process";
export { promptFor } from "./prompt";
export type {
  PiAssistantMessage,
  PiCommand,
  PiCommandInfo,
  PiContent,
  PiExtensionUiRequest,
  PiModel,
  PiRecord,
  PiResponse,
  PiSessionEvent,
  PiSessionStats,
  PiState,
  PiToolResult,
  PiUsage,
} from "./protocol";
export { PiRpc, PiRpcError, type PiRpcHandlers } from "./rpc";
export { PiSession, type PiSessionConfig } from "./session";
