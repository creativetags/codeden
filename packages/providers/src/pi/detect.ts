import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ProviderIssue, ProviderStatus } from "@codeden/contracts";
import { brokenInstallMessage, type DetectExeOptions, lookupForDetect } from "../util/detect-exe";
import { type ResolvedCommand, runCommand } from "../util/exec";
import { compareVersions } from "../util/version";

export const PI_PROVIDER_ID = "pi";

/**
 * The oldest Pi CodeDen runs sessions with. The RPC mode and the extension API here are the ones
 * documented for 1.5.x, which is what CodeDen was written and tested against (1.5.2).
 */
export const PI_MIN_VERSION = "1.5.0";

export const PI_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";
export const PI_UPGRADE_COMMAND = "pi update";

/** "Pi 1.2.0 is too old (needs 1.5.0+)": detection, and a session refusing to open. */
export function piTooOldMessage(version: string | null | undefined): string {
  return `Pi ${version || "(unknown version)"} is too old (needs ${PI_MIN_VERSION}+)`;
}

export function isSupportedPiVersion(version: string | null | undefined): boolean {
  return !!version && compareVersions(version, PI_MIN_VERSION) >= 0;
}

/** Pi's agent folder: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent` (its settings and logins). */
export function piAgentDir(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
}

/**
 * The startup model the user picked in Pi's own settings (`defaultProvider` and `defaultModel`),
 * which is the one whose credentials say whether Pi is ready. Reads settings, never a credential.
 */
export function readPiDefaultModel(
  dir: string = piAgentDir(),
): { provider?: string; model?: string } | undefined {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
  const provider =
    typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
  const model = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
  if (!provider && !model) return undefined;
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

/** What `pi auth check` said about the startup model. */
export interface PiAuth {
  loggedIn: boolean | null;
  authMethod: string | null;
  /** Why it could not be confirmed. */
  note?: string;
}

/**
 * Ask Pi whether its startup model is ready (`pi auth check --provider … --model …`): exit 0
 * `ready`, 1 `not_ready` (no credentials), 2 `invalid` (stored credentials Pi can't use). Pi calls
 * a provider whose key comes from the environment "invalid" even when it works, so 2 is reported as
 * unknown, never as signed out. Credentials are never read.
 */
export async function readPiAuth(
  exe: ResolvedCommand,
  opts: { agentDir?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<PiAuth> {
  const startup = readPiDefaultModel(opts.agentDir);
  if (!startup?.provider && !startup?.model) {
    return {
      loggedIn: null,
      authMethod: null,
      note: "Pi has no startup model in its settings, so there is no login to check",
    };
  }
  const args = ["auth", "check", "--json"];
  if (startup.provider) args.push("--provider", startup.provider);
  if (startup.model) args.push("--model", startup.model);
  const run = await runCommand(exe, args, {
    timeoutMs: opts.timeoutMs ?? 15_000,
    ...(opts.env ? { env: opts.env } : {}),
  });
  const answer = parseAuthCheck(run.stdout);
  const method = startup.provider ?? null;
  if (run.code === 0) return { loggedIn: true, authMethod: method };
  if (run.code === 1) {
    return { loggedIn: false, authMethod: method, ...(answer ? { note: answer } : {}) };
  }
  if (run.code === 2) {
    return {
      loggedIn: null,
      authMethod: method,
      note: answer ? `Pi reports ${answer}` : "Pi reports its credentials as invalid",
    };
  }
  return {
    loggedIn: null,
    authMethod: method,
    note: run.error?.message || "`pi auth check` did not answer",
  };
}

/** The `reason` of `pi auth check --json`, for a note ("credentials_not_configured"). */
function parseAuthCheck(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

export interface PiDetectOptions extends DetectExeOptions {
  /** Reads the login (default `readPiAuth()` against the installed copy). */
  auth?: (exe: ResolvedCommand) => Promise<PiAuth>;
}

/**
 * Find a working `pi` (PATH, then Homebrew's folders on macOS), check its version, and ask Pi about
 * its login (§14). The user's own Pi login, settings and extensions are reused; CodeDen holds no
 * credentials. Never throws.
 */
export async function detectPi(opts: PiDetectOptions = {}): Promise<ProviderStatus> {
  const status: ProviderStatus = {
    providerId: PI_PROVIDER_ID,
    installed: false,
    version: null,
    executablePath: null,
    loggedIn: null,
    authMethod: null,
    account: null,
    loginExpiresAt: null,
    supported: false,
    issues: [],
    checkedAt: new Date().toISOString(),
  };
  const issues: ProviderIssue[] = [];
  const install = { kind: "install" as const, command: PI_INSTALL_COMMAND };
  const upgrade = { kind: "upgrade" as const, command: PI_UPGRADE_COMMAND };
  const lookup = await lookupForDetect("pi", { ...opts, timeoutMs: opts.timeoutMs ?? 15_000 });
  const broken = lookup.broken.length > 0 ? { broken: lookup.broken } : {};
  const exe = lookup.command;
  if (!exe) {
    issues.push(
      lookup.broken.length > 0
        ? {
            code: "broken_install",
            message: brokenInstallMessage("Pi", lookup.broken),
            fix: install,
          }
        : {
            code: "not_installed",
            message: "Pi is not installed (no `pi` on PATH).",
            fix: install,
          },
    );
    return { ...status, ...broken, issues };
  }
  const found = {
    ...status,
    ...broken,
    installed: true,
    version: lookup.version,
    executablePath: exe.kind === "node-script" ? exe.script : exe.path,
  };
  if (!isSupportedPiVersion(lookup.version)) {
    // Sessions refuse to open on it (`PiAdapter.openSession`): `minVersion` makes it unavailable.
    issues.push({
      code: "version_unsupported",
      message: `${piTooOldMessage(lookup.version)}. Update it with \`${PI_UPGRADE_COMMAND}\`.`,
      fix: upgrade,
      minVersion: PI_MIN_VERSION,
    });
    return { ...found, issues };
  }
  const auth = opts.auth ? await opts.auth(exe) : await readPiAuth(exe);
  // `pi auth login` needs the provider to sign in to, which is the startup model's provider.
  const login = auth.authMethod
    ? { kind: "login" as const, command: `pi auth login ${auth.authMethod}` }
    : undefined;
  if (auth.loggedIn === false) {
    issues.push({
      code: "not_logged_in",
      message: "Pi is not signed in to its startup model.",
      ...(login ? { fix: login } : {}),
    });
  } else if (auth.loggedIn === null) {
    issues.push({
      code: "detect_failed",
      message: `Could not confirm Pi's login${auth.note ? `: ${auth.note}` : ""}.`,
      ...(login ? { fix: login } : {}),
    });
  }
  return {
    ...found,
    supported: true,
    loggedIn: auth.loggedIn,
    authMethod: auth.authMethod,
    issues,
  };
}
