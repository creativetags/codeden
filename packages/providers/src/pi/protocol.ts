/**
 * The subset of Pi's RPC protocol (`pi --mode rpc`) that CodeDen uses, written from the installed
 * package's own docs (rpc.md, rpc-commands.md, json.md, message-types.md). Fields CodeDen does
 * not read are left out; everything a record may omit is optional.
 */

/** One line of Pi's stdout: the answer to a command, a session event, or an extension's call. */
export type PiRecord = PiResponse | PiSessionEvent | PiExtensionUiRequest;

/** The answer to one command. `id` is the id CodeDen gave it; `data` is the command's result. */
export interface PiResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type PiContent = PiTextContent | PiThinkingContent | PiToolCallContent | PiImageContent;

/** Token counts and cost, as Pi reports them (cost in USD, `reasoning` already in `output`). */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface PiUserMessage {
  role: "user";
  content: string | PiContent[];
  timestamp?: number;
}

/**
 * An assistant message. `stopReason` is `"pending"` while it streams; a completed one ends with
 * `stop`, `length`, `toolUse`, `error`, `aborted` or `deferred`.
 */
export interface PiAssistantMessage {
  role: "assistant";
  content: PiContent[];
  provider?: string;
  model?: string;
  responseModel?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: PiContent[];
  isError?: boolean;
  usage?: PiUsage;
  timestamp?: number;
}

/** A shell command run through Pi's own `bash` command (not a model tool call). */
export interface PiBashExecutionMessage {
  role: "bashExecution";
  command?: string;
  output?: string;
  exitCode?: number;
  timestamp?: number;
}

export type PiMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage;

/** What a tool execution returned: its content blocks and tool-specific `details`. */
export interface PiToolResult {
  content?: PiContent[];
  details?: unknown;
}

/** One content-block update of a streaming assistant message. */
export type PiStreamEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id?: string; toolName?: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall?: PiToolCallContent }
  | { type: "done"; reason?: string }
  | { type: "error"; reason?: string; error?: string };

export interface PiCompactionResult {
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  usage?: PiUsage;
}

/**
 * A session event (json.md): what happens inside a run. `agent_start` and `agent_end` open and
 * close one low-level run, and only `agent_settled` says Pi will not continue by itself (no
 * retry, compaction recovery or queued message left).
 */
export type PiSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: PiMessage[]; willRetry?: boolean }
  | { type: "agent_settled"; aborted?: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: PiAssistantMessage; toolResults?: PiToolResultMessage[] }
  | { type: "message_start"; message: PiMessage }
  | { type: "message_update"; usage?: PiUsage; assistantMessageEvent: PiStreamEvent }
  | { type: "message_end"; message: PiMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
      partialResult?: PiToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
      result?: PiToolResult;
      isError?: boolean;
      durationMs?: number;
    }
  | { type: "queue_update"; steering?: string[]; followUp?: string[] }
  | { type: "entry_appended"; entry?: unknown }
  | { type: "session_info_changed"; name?: string }
  | { type: "thinking_level_changed"; level?: string }
  | { type: "compaction_start"; reason?: string }
  | {
      type: "compaction_end";
      reason?: string;
      result?: PiCompactionResult;
      aborted?: boolean;
      errorMessage?: string;
      willRetry?: boolean;
    }
  | {
      type: "auto_retry_start";
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      errorMessage?: string;
    }
  | { type: "auto_retry_end"; success?: boolean; attempt?: number; finalError?: string }
  | {
      type: "summarization_retry_scheduled";
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      errorMessage?: string;
    }
  | { type: "summarization_retry_attempt_start"; source?: string; reason?: string }
  | { type: "summarization_retry_finished" }
  | { type: "bash_execution_update"; id?: string; delta?: string }
  | { type: "extension_error"; extensionPath?: string; event?: string; error?: string };

/**
 * An extension asking the client for something (`rpc-extension-ui.md`). `select`, `confirm`,
 * `input` and `editor` wait for an answer with the same `id`; `notify`, `setStatus`, `setWidget`,
 * `setTitle` and `set_editor_text` expect none.
 */
export interface PiExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  timeout?: number;
}

/** CodeDen's answer to an `extension_ui_request`. */
export interface PiExtensionUiResponse {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** Commands CodeDen sends. Each carries an `id` (except extension UI answers). */
export type PiCommand =
  | { type: "prompt"; message: string; images?: PiImageContent[]; streamingBehavior?: string }
  | { type: "steer"; message: string }
  | { type: "abort" }
  /** End an automatic retry (or a compaction recovery) that is waiting, without a running run. */
  | { type: "abort_retry" }
  /** Name Pi's own session file, which its picker and `--export` show. */
  | { type: "set_session_name"; name: string }
  | { type: "compact"; customInstructions?: string }
  | { type: "get_state" }
  | { type: "get_available_models" }
  | { type: "get_available_thinking_levels" }
  | { type: "get_commands" }
  | { type: "get_session_stats" }
  /** The session's entries in append order, or (with `since`) those after that entry id. */
  | { type: "get_entries"; since?: string }
  /** The user messages of the active branch, in order: where `fork` can start from. */
  | { type: "get_fork_messages" }
  /** Copy the branch from a user message into a new session (the message is left out). */
  | { type: "fork"; entryId: string }
  /** Copy the whole active branch into a new session. */
  | { type: "clone" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string };

/** The dialog methods: an `extension_ui_request` with one of these waits for an answer. */
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** A model as Pi lists it (`get_available_models`, `get_state`). */
export interface PiModel {
  id: string;
  name?: string;
  provider: string;
  /** Whether the model reasons, and the provider value each thinking level maps to. */
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  /** `["text"]`, `["text", "image"]`, ... */
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: PiUsage["cost"];
}

export interface PiState {
  model?: PiModel;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
}

/**
 * One entry of Pi's session tree (`get_entries`, `session-format.md`). CodeDen reads the id (a
 * cursor, and a fork point), whether the entry is the start of a turn (a `user` message), and
 * that Pi's own appends follow their parent.
 */
export interface PiEntry {
  id: string;
  /** `message`, `custom_message`, `branch_summary`, `compaction`, ... */
  type: string;
  parentId?: string | null;
  /** What a `message` entry carries. */
  message?: { role?: string };
}

/** One user message a fork can start from (`get_fork_messages`). */
export interface PiForkMessage {
  entryId: string;
  text: string;
}

/** Session statistics (`get_session_stats`): usage so far and the current context window. */
export interface PiSessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  /** Absent when no model or context window is known; `tokens` is null right after compaction. */
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}

/** A `/` command Pi reports (`get_commands`): an extension command, prompt template or skill. */
export interface PiCommandInfo {
  name: string;
  description?: string;
  source?: string;
}
