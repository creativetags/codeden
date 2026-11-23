import { agentEnv } from "../util/agent-env";

/**
 * Pi's own variables that describe the process CodeDen started it from. A session must not inherit
 * them: a Pi running inside Pi (CodeDen started from a Pi session) would otherwise point its child
 * at the parent's session file, model and reasoning level.
 */
const PI_PROCESS_VARS = new Set([
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_CODING_AGENT",
]);

/**
 * The environment a Pi session runs in (§15): the runner's, without CodeDen's own variables
 * (`agentEnv`) and without a parent Pi's session, plus what CodeDen means the session to see.
 */
export function piEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = agentEnv(extra);
  for (const name of Object.keys(env)) {
    if (PI_PROCESS_VARS.has(name.toUpperCase())) delete env[name];
  }
  return env;
}
