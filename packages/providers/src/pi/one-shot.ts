import { tmpdir } from "node:os";
import { type ResolvedCommand, runCommand } from "../util/exec";
import { explicitModel } from "../util/model";
import type { OneShotRequest, UtilityModel } from "../utility";
import { piEnv } from "./env";
import { splitModelId } from "./models";

/** Empty string = the model Pi itself is configured with (its settings and credentials). */
export const PI_UTILITY_MODEL = "";

/**
 * One-shot Pi call for the utility model (§7.4): print mode (`--print`) with no session, no
 * tools, no skills, no extensions and no MCP servers, thinking off, so a job is one model call
 * and Pi writes its final text to stdout. A named model goes in as `--model` (or
 * `--provider`/`--model`), and a system prompt replaces Pi's coding prompt (`--system-prompt`).
 */
export class PiUtilityModel implements UtilityModel {
  readonly providerId = "pi";
  readonly defaultModel = PI_UTILITY_MODEL;

  constructor(private readonly resolveExecutable: () => Promise<ResolvedCommand | undefined>) {}

  async runOneShot(request: OneShotRequest): Promise<string> {
    const exe = await this.resolveExecutable();
    if (!exe) throw new Error("Pi is not installed");
    // A scratch folder: the job reads nothing of the user's project (no context files are found).
    const result = await runCommand(exe, this.args(request), {
      cwd: tmpdir(),
      env: piEnv(),
      timeoutMs: request.timeoutMs ?? 60_000,
    });
    if (result.error) throw result.error;
    if (result.timedOut) throw new Error("Pi did not answer in time");
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n").slice(-3).join(" ").slice(-400);
      throw new Error(detail || `pi --print exited with code ${result.code ?? "unknown"}`);
    }
    return result.stdout.trim();
  }

  private args(request: OneShotRequest): string[] {
    const args = [
      "--print",
      "--no-session",
      "--no-tools",
      "--no-skills",
      "--no-extensions",
      "--no-mcp",
      // A project's own Pi resources and context files stay out of a side job.
      "--no-approve",
      "--thinking",
      "off",
    ];
    const model = explicitModel(request.model);
    if (model) {
      const split = splitModelId(model);
      if (split.provider) args.push("--provider", split.provider, "--model", split.modelId);
      else args.push("--model", model);
    }
    const system = request.system?.trim();
    if (system) args.push("--system-prompt", system);
    args.push(request.prompt);
    return args;
  }
}
