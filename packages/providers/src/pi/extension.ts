import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "@codeden/contracts";

/**
 * The status key the gate reports through `ctx.ui.setStatus` once it is loaded: CodeDen treats a
 * session without it as ungated and refuses to run it.
 */
export const GATE_STATUS_KEY = "codeden-gate";

/**
 * MCP servers as `mcp.json` entries (`pi.registerMcpServer` takes the same shape). CodeDen's own
 * server is an HTTP one with its session token in a header; a stdio server keeps its command,
 * arguments and environment.
 */
function mcpEntries(servers: readonly McpServerConfig[]): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const server of servers) {
    entries[server.name] =
      server.transport === "http"
        ? {
            url: server.url,
            ...(server.headers && Object.keys(server.headers).length
              ? { headers: { ...server.headers } }
              : {}),
          }
        : {
            command: server.command,
            args: [...server.args],
            ...(server.env && Object.keys(server.env).length ? { env: { ...server.env } } : {}),
          };
  }
  return entries;
}

/**
 * Source of the extension CodeDen loads into every Pi session (`pi --extension <path>`). It does
 * the two things Pi keeps for extensions only:
 *
 * - **Approvals.** Pi has no permission system of its own, so every tool call is sent to CodeDen
 *   as an `extension_ui_request` (a JSON request in an `input` dialog, answered with a JSON
 *   decision) and decided by the session's policy (§11.2). Anything but an explicit allow blocks
 *   the call, so a missing or failed CodeDen on the other end can never let a call through.
 * - **CodeDen's MCP server**, registered for this session with the session's own token.
 *
 * It is written per session, into CodeDen's home: a session's token never reaches another one. The
 * agent can read the file (it runs as the same user), which the MCP server's per-role, per-session
 * scope and the tool gate bound.
 */
export function gateExtensionSource(servers: readonly McpServerConfig[]): string {
  const entries = JSON.stringify(mcpEntries(servers), null, 2);
  return `// Written by CodeDen for one session: the tool approval gate and CodeDen's MCP servers.
// Do not edit: it is rewritten whenever the session opens.
const SERVERS = ${entries};
const GATE_KEY = ${JSON.stringify(GATE_STATUS_KEY)};

export default function codeden(pi) {
  for (const [name, config] of Object.entries(SERVERS)) pi.registerMcpServer(name, config);

  // Loaded and gating: CodeDen waits for this before it lets the session run.
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus(GATE_KEY, "ready");
  });

  pi.on("tool_call", async (event, ctx) => {
    const request = {
      version: 1,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input ?? {},
      cwd: ctx.cwd,
    };
    // Fail-safe: an answer that is missing, unreadable or not an allow blocks the call.
    let decision = "deny";
    let reason = "CodeDen did not answer the approval request";
    try {
      const answer = await ctx.ui.input(JSON.stringify(request), GATE_KEY);
      const parsed = JSON.parse(answer ?? "");
      if (parsed && typeof parsed.decision === "string") {
        decision = parsed.decision;
        if (typeof parsed.reason === "string" && parsed.reason) reason = parsed.reason;
      }
    } catch {
      // Keep the denial.
    }
    if (decision === "allow_once" || decision === "allow_session") return undefined;
    return { block: true, reason };
  });
}
`;
}

/** Write a session's extension into `dir` (mode 0700) and return its path. */
export function writeGateExtension(
  dir: string,
  sessionId: string,
  servers: readonly McpServerConfig[],
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${sessionId}.extension.ts`);
  writeFileSync(file, gateExtensionSource(servers), { mode: 0o600 });
  return file;
}

/** The approval request the gate sends, as CodeDen reads it back. */
export interface PiApprovalRequest {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  cwd?: string;
}

/** CodeDen's answer to the gate. */
export interface PiApprovalAnswer {
  decision: "allow_once" | "allow_session" | "deny";
  reason?: string;
}

/** Parse the gate's request. Returns undefined for anything that is not one. */
export function parseApprovalRequest(title: string | undefined): PiApprovalRequest | undefined {
  if (!title) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(title);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = parsed as Record<string, unknown>;
  const input = value.input;
  if (typeof value.toolName !== "string") return undefined;
  return {
    toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : "",
    toolName: value.toolName,
    input:
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {},
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
  };
}
