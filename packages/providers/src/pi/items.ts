import { existsSync } from "node:fs";
import path from "node:path";
import type { AcpToolState } from "../acp/items";
import type { AcpToolContent } from "../acp/protocol";
import type { PiContent, PiToolResult } from "./protocol";

/** Pi's own tool names (`pi --help`), as the gate and the transcript see them. */
const NAME = "mcp__";

/** One tool call Pi started, as CodeDen sees it. */
export interface PiToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** The session's worktree: relative paths resolve against it. */
  cwd: string;
}

/** The MCP server and tool an `mcp__<server>__<tool>` name belongs to. */
export function mcpTarget(
  toolName: string,
  servers: readonly string[],
): { server: string; tool: string } | undefined {
  if (!toolName.startsWith(NAME)) return undefined;
  const rest = toolName.slice(NAME.length);
  // A server name may itself contain `__`; prefer the longest known one.
  for (const server of [...servers].sort((a, b) => b.length - a.length)) {
    if (rest.startsWith(`${server}__`) && rest.length > server.length + 2) {
      return { server, tool: rest.slice(server.length + 2) };
    }
  }
  const split = rest.indexOf("__");
  if (split <= 0 || split === rest.length - 2) return undefined;
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * A Pi tool call as the shared tool-call state (`../acp/items`), so its transcript item is built
 * exactly like the other providers': a command, an edit with its change, a read, a search, an MCP
 * call. Pi names its built-in tools, and only an `mcp__<server>__<tool>` name can be an MCP call,
 * so a shell command is always judged as one. Pi takes no approval of its own: the gate
 * (`./extension`) sends each call here before it runs.
 */
export function toolStateOf(call: PiToolCall, mcpServers: readonly string[]): AcpToolState {
  const input = call.input;
  const file = text(input.path);
  const state: AcpToolState = {
    toolCallId: call.toolCallId,
    name: call.toolName,
    status: "in_progress",
    rawInput: input,
  };
  switch (call.toolName) {
    case "bash":
    case "powershell":
      state.kind = "execute";
      state.title = `Run ${text(input.command) ?? "a command"}`;
      state.rawInput = { ...input, cwd: call.cwd };
      return state;
    case "edit": {
      state.kind = "edit";
      const oldText = typeof input.oldText === "string" ? input.oldText : "";
      const newText = typeof input.newText === "string" ? input.newText : "";
      state.content = file ? [diff(call.cwd, file, oldText, newText)] : [];
      state.locations = file ? [{ path: file }] : [];
      return state;
    }
    case "write": {
      state.kind = "edit";
      const newText = typeof input.content === "string" ? input.content : "";
      state.content = file
        ? [diff(call.cwd, file, exists(file, call.cwd) ? "" : null, newText)]
        : [];
      state.locations = file ? [{ path: file }] : [];
      return state;
    }
    case "read": {
      state.kind = "read";
      const offset =
        typeof input.offset === "number" ? Math.max(1, Math.round(input.offset)) : undefined;
      state.locations = file ? [{ path: file, ...(offset ? { line: offset } : {}) }] : [];
      return state;
    }
    case "grep":
    case "find":
      state.kind = "search";
      return state;
    case "ls":
      state.kind = "read";
      state.locations = file ? [{ path: file }] : [];
      return state;
    default: {
      // `codemode`, `tool_search`, extension tools and MCP tools: judged as `other`, with the MCP
      // identity the tool name gives (never a title the model wrote).
      state.kind = "other";
      const mcp = mcpTarget(call.toolName, mcpServers);
      if (mcp) state.mcp = mcp;
      return state;
    }
  }
}

function exists(file: string, cwd: string): boolean {
  return existsSync(path.resolve(cwd, file));
}

function diff(cwd: string, file: string, oldText: string | null, newText: string): AcpToolContent {
  // Absolute paths keep the change in the worktree even if the model wrote a relative one.
  return { type: "diff", path: path.resolve(cwd, file), oldText, newText };
}

/** A tool execution's result content, as the shared item builder reads it (text only). */
export function resultContent(result: PiToolResult | undefined): AcpToolContent[] {
  const content: AcpToolContent[] = [];
  for (const block of result?.content ?? []) {
    if (block.type === "text" && block.text) {
      content.push({ type: "content", content: { type: "text", text: block.text } });
    }
  }
  if (!content.length) {
    // A tool with no text output still says how it went (a write, an edit).
    const details = detailsText(result?.details);
    if (details) content.push({ type: "content", content: { type: "text", text: details } });
  }
  return content;
}

/** Text from a tool's `details`, when it carries one (an edit's summary, a truncation notice). */
function detailsText(details: unknown): string {
  if (!details || typeof details !== "object") return "";
  const record = details as Record<string, unknown>;
  for (const key of ["summary", "message", "output", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/**
 * Pi message content as text: the model's own blocks, with images and tool calls left out (they
 * become their own items or are not shown).
 */
export function contentText(content: PiContent[] | string | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}
