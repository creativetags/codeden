import { basename, join } from "node:path";
import type { AgentConfigFile } from "@codeden/contracts";
import { isInside } from "../files/path-guard";
import {
  type ConfigRoot,
  type DiscoveredSkill,
  existing,
  fileEntry,
  filesUnder,
  nestedMemoryFiles,
  skillsIn,
  subagentsIn,
} from "./discovery";
import { ancestors, dirsFromRootTo } from "./paths";

/**
 * Where each provider keeps its native files (§12.4), as lists of `AgentConfigFile`s.
 * `list*` functions describe what exists for the settings screens; `loaded*` functions
 * apply each provider's discovery rules from a working directory.
 */

export interface ProjectRef {
  id: string;
  path: string;
  /** Claude's auto-memory folder for the repo. */
  autoMemoryDir: string;
}

const homeRoot = (home: string): ConfigRoot => ({ root: "home", dir: home });
const projectRoot = (p: ProjectRef): ConfigRoot => ({
  root: "project",
  dir: p.path,
  projectId: p.id,
});
const memoryRoot = (p: ProjectRef): ConfigRoot => ({
  root: "auto_memory",
  dir: p.autoMemoryDir,
  projectId: p.id,
});

// ------------------------------------------------------------------------------ listing

/** Claude's user-level files: CLAUDE.md, rules, skills, subagents. */
export function listClaudeUser(home: string): AgentConfigFile[] {
  const r = homeRoot(home);
  const dir = join(home, ".claude");
  return [
    fileEntry(r, join(dir, "CLAUDE.md"), { provider: "claude", kind: "memory", scope: "user" }),
    ...filesUnder(join(dir, "rules")).map((f) =>
      fileEntry(r, f, { provider: "claude", kind: "rule", scope: "user" }),
    ),
    ...skillsIn(r, join(dir, "skills"), "claude", "user").map((s) => s.file),
    ...subagentsIn(r, join(dir, "agents"), "claude", "user"),
  ];
}

/** Codex's user-level files: AGENTS.md (and the override), skills, agents. */
export function listCodexUser(home: string): AgentConfigFile[] {
  const r = homeRoot(home);
  const dir = join(home, ".codex");
  return [
    fileEntry(r, join(dir, "AGENTS.md"), { provider: "codex", kind: "memory", scope: "user" }),
    ...existing(r, join(dir, "AGENTS.override.md"), {
      provider: "codex",
      kind: "memory",
      scope: "user",
    }),
    ...codexUserSkills(home).map((s) => s.file),
    ...subagentsIn(r, join(dir, "agents"), "codex", "user"),
  ];
}

/** Pi's agent directory, where its own configuration and user resources live. */
export function piAgentDir(home: string): string {
  return join(home, ".pi", "agent");
}

/** Pi's user-level files: its AGENTS.md (or override, or CLAUDE.md) and its skills. */
export function listPiUser(home: string): AgentConfigFile[] {
  const r = homeRoot(home);
  const dir = piAgentDir(home);
  const memory = (name: string, force: boolean) => {
    const meta = { provider: "pi", kind: "memory", scope: "user" } as const;
    return force ? [fileEntry(r, join(dir, name), meta)] : existing(r, join(dir, name), meta);
  };
  return [
    ...memory("AGENTS.md", true),
    ...memory("AGENTS.override.md", false),
    ...memory("CLAUDE.md", false),
    ...skillsIn(r, join(dir, "skills"), "pi", "user").map((s) => s.file),
  ];
}

/** A project's Claude files: root and nested CLAUDE.md, local file, rules, skills, subagents, auto memory. */
export function listClaudeProject(p: ProjectRef): AgentConfigFile[] {
  const r = projectRoot(p);
  const claude = (path: string, kind: AgentConfigFile["kind"], scope: AgentConfigFile["scope"]) =>
    fileEntry(r, path, { provider: "claude", kind, scope });
  const nested = nestedMemoryFiles(p.path).filter((f) =>
    /^claude(\.local)?\.md$/i.test(basename(f)),
  );
  return [
    claude(join(p.path, "CLAUDE.md"), "memory", "project"),
    ...existing(r, join(p.path, ".claude", "CLAUDE.md"), {
      provider: "claude",
      kind: "memory",
      scope: "project",
    }),
    claude(join(p.path, "CLAUDE.local.md"), "memory", "local"),
    ...nested.map((f) =>
      fileEntry(r, f, {
        provider: "claude",
        kind: "memory",
        scope: /local/i.test(basename(f)) ? "local" : "project",
        onDemand: true,
      }),
    ),
    ...filesUnder(join(p.path, ".claude", "rules")).map((f) => claude(f, "rule", "project")),
    ...skillsIn(r, join(p.path, ".claude", "skills"), "claude", "project").map((s) => s.file),
    ...subagentsIn(r, join(p.path, ".claude", "agents"), "claude", "project"),
    ...listAutoMemory(p),
  ];
}

/** Claude's auto-memory folder: `MEMORY.md` (always listed) and the topic files. */
export function listAutoMemory(p: ProjectRef): AgentConfigFile[] {
  const r = memoryRoot(p);
  const index = join(p.autoMemoryDir, "MEMORY.md");
  const meta = { provider: "claude", kind: "auto_memory", scope: "local" } as const;
  return [
    fileEntry(r, index, meta),
    ...filesUnder(p.autoMemoryDir)
      .filter((f) => f.toLowerCase() !== index.toLowerCase())
      .map((f) => fileEntry(r, f, meta)),
  ];
}

/**
 * A project's Pi files: the context files it loads (`AGENTS.md`, `AGENTS.override.md` or
 * `CLAUDE.md`, in the project and its folders) and its skills (`.pi/skills`, `.agents/skills`).
 */
export function listPiProject(p: ProjectRef): AgentConfigFile[] {
  const r = projectRoot(p);
  const meta = { provider: "pi", kind: "memory", scope: "project" } as const;
  const nested = nestedMemoryFiles(p.path).filter((f) =>
    /^(agents(\.override)?|claude)\.md$/i.test(basename(f)),
  );
  return [
    fileEntry(r, join(p.path, "AGENTS.md"), meta),
    ...existing(r, join(p.path, "AGENTS.override.md"), meta),
    ...existing(r, join(p.path, "CLAUDE.md"), meta),
    ...nested.map((f) => fileEntry(r, f, meta)),
    ...skillsIn(r, join(p.path, ".pi", "skills"), "pi", "project").map((s) => s.file),
    ...skillsIn(r, join(p.path, ".agents", "skills"), "pi", "project").map((s) => s.file),
  ];
}

/** A project's Codex files: root and nested AGENTS.md, skills, agents. */
export function listCodexProject(p: ProjectRef): AgentConfigFile[] {
  const r = projectRoot(p);
  const nested = nestedMemoryFiles(p.path).filter((f) =>
    /^agents(\.override)?\.md$/i.test(basename(f)),
  );
  return [
    fileEntry(r, join(p.path, "AGENTS.md"), {
      provider: "codex",
      kind: "memory",
      scope: "project",
    }),
    ...existing(r, join(p.path, "AGENTS.override.md"), {
      provider: "codex",
      kind: "memory",
      scope: "project",
    }),
    ...nested.map((f) => fileEntry(r, f, { provider: "codex", kind: "memory", scope: "project" })),
    ...skillsIn(r, join(p.path, ".agents", "skills"), "codex", "project").map((s) => s.file),
    ...subagentsIn(r, join(p.path, ".codex", "agents"), "codex", "project"),
  ];
}

function codexUserSkills(home: string): DiscoveredSkill[] {
  const r = homeRoot(home);
  return [
    ...skillsIn(r, join(home, ".codex", "skills"), "codex", "user"),
    ...skillsIn(r, join(home, ".agents", "skills"), "codex", "user"),
  ];
}

/** Every provider's user skills, plus the project's (the Skills tab's switches). */
export function listSkills(home: string, project: ProjectRef | null): DiscoveredSkill[] {
  const r = project ? projectRoot(project) : null;
  return [
    ...skillsIn(homeRoot(home), join(home, ".claude", "skills"), "claude", "user"),
    ...codexUserSkills(home),
    ...skillsIn(homeRoot(home), join(piAgentDir(home), "skills"), "pi", "user"),
    ...(project && r
      ? [
          ...skillsIn(r, join(project.path, ".claude", "skills"), "claude", "project"),
          ...skillsIn(r, join(project.path, ".agents", "skills"), "codex", "project"),
          ...skillsIn(r, join(project.path, ".pi", "skills"), "pi", "project"),
          ...skillsIn(r, join(project.path, ".agents", "skills"), "pi", "project"),
        ]
      : []),
  ];
}

// ------------------------------------------------------------------------------ loaded

export interface LoadedFiles {
  memory: AgentConfigFile[];
  skills: DiscoveredSkill[];
  subagents: AgentConfigFile[];
}

/** Dedupe by absolute path (case-insensitively on Windows and macOS), keeping the first. */
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const fold = process.platform === "linux" ? (s: string) => s : (s: string) => s.toLowerCase();
  return items.filter((item) => {
    const k = fold(key(item));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * What Claude Code loads at session start from `cwd`: user CLAUDE.md and rules, then CLAUDE.md,
 * `.claude/CLAUDE.md`, CLAUDE.local.md and `.claude/rules` in every ancestor (broadest first),
 * the auto-memory index, user and project skills and subagents (project ones from `cwd` up to
 * the repo root).
 */
export function loadedClaude(
  home: string,
  cwd: string,
  gitRoot: string | null,
  project: ProjectRef | null,
): LoadedFiles {
  const h = homeRoot(home);
  const r: ConfigRoot = project ? projectRoot(project) : { root: "home", dir: home };
  const dirs = ancestors(cwd).reverse();
  const memory: AgentConfigFile[] = [
    ...existing(h, join(home, ".claude", "CLAUDE.md"), {
      provider: "claude",
      kind: "memory",
      scope: "user",
    }),
    ...filesUnder(join(home, ".claude", "rules")).map((f) =>
      fileEntry(h, f, { provider: "claude", kind: "rule", scope: "user" }),
    ),
  ];
  for (const dir of dirs) {
    const root = rootFor(dir, h, r);
    for (const name of ["CLAUDE.md", join(".claude", "CLAUDE.md")]) {
      memory.push(
        ...existing(root, join(dir, name), {
          provider: "claude",
          kind: "memory",
          scope: "project",
        }),
      );
    }
    memory.push(
      ...existing(root, join(dir, "CLAUDE.local.md"), {
        provider: "claude",
        kind: "memory",
        scope: "local",
      }),
      ...filesUnder(join(dir, ".claude", "rules")).map((f) =>
        fileEntry(root, f, { provider: "claude", kind: "rule", scope: "project" }),
      ),
    );
  }
  if (project) {
    memory.push(
      ...existing(memoryRoot(project), join(project.autoMemoryDir, "MEMORY.md"), {
        provider: "claude",
        kind: "auto_memory",
        scope: "local",
      }),
    );
  }
  const upToRepo = gitRoot ? dirsFromRootTo(gitRoot, cwd).reverse() : [cwd];
  const skills = [
    ...skillsIn(h, join(home, ".claude", "skills"), "claude", "user"),
    ...upToRepo.flatMap((d) =>
      skillsIn(rootFor(d, h, r), join(d, ".claude", "skills"), "claude", "project"),
    ),
  ];
  const subagents = [
    ...subagentsIn(h, join(home, ".claude", "agents"), "claude", "user"),
    ...upToRepo.flatMap((d) =>
      subagentsIn(rootFor(d, h, r), join(d, ".claude", "agents"), "claude", "project"),
    ),
  ];
  return {
    memory: unique(memory, (f) => f.absolutePath),
    skills: unique(skills, (s) => s.file.absolutePath),
    subagents: unique(subagents, (f) => f.absolutePath),
  };
}

/**
 * What Codex loads from `cwd`: `~/.codex/AGENTS.override.md` or `AGENTS.md`, then in each
 * folder from the repo root down to `cwd` its `AGENTS.override.md` or `AGENTS.md`; skills from
 * `~/.codex/skills`, `~/.agents/skills` and `.agents/skills` from the repo root to `cwd`.
 */
export function loadedCodex(
  home: string,
  cwd: string,
  gitRoot: string | null,
  project: ProjectRef | null,
): LoadedFiles {
  const h = homeRoot(home);
  const r: ConfigRoot = project ? projectRoot(project) : h;
  const first = (root: ConfigRoot, dir: string, scope: AgentConfigFile["scope"]) => {
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
      const found = existing(root, join(dir, name), { provider: "codex", kind: "memory", scope });
      if (found.length) return found;
    }
    return [];
  };
  const chain = dirsFromRootTo(gitRoot ?? cwd, cwd);
  const memory = [
    ...first(h, join(home, ".codex"), "user"),
    ...chain.flatMap((d) => first(rootFor(d, h, r), d, "project")),
  ];
  const skills = [
    ...codexUserSkills(home),
    ...chain.flatMap((d) =>
      skillsIn(rootFor(d, h, r), join(d, ".agents", "skills"), "codex", "project"),
    ),
  ];
  const subagents = [
    ...subagentsIn(h, join(home, ".codex", "agents"), "codex", "user"),
    ...(gitRoot
      ? subagentsIn(rootFor(gitRoot, h, r), join(gitRoot, ".codex", "agents"), "codex", "project")
      : []),
  ];
  return {
    memory: unique(memory, (f) => f.absolutePath),
    skills: unique(skills, (s) => s.file.absolutePath),
    subagents: unique(subagents, (f) => f.absolutePath),
  };
}

/**
 * What Pi loads at session start from `cwd`: its agent directory's context file (`AGENTS.md`,
 * an `AGENTS.override.md`, or `CLAUDE.md`) and skills, then the same context files and skills in
 * every folder from the repo root down to `cwd`.
 */
export function loadedPi(
  home: string,
  cwd: string,
  gitRoot: string | null,
  project: ProjectRef | null,
): LoadedFiles {
  const h = homeRoot(home);
  const r: ConfigRoot = project ? projectRoot(project) : h;
  const agentDir = piAgentDir(home);
  // An override in a folder replaces that folder's AGENTS.md/CLAUDE.md, so only the first shows.
  const first = (root: ConfigRoot, dir: string, scope: AgentConfigFile["scope"]) => {
    for (const name of ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]) {
      const found = existing(root, join(dir, name), { provider: "pi", kind: "memory", scope });
      if (found.length) return found;
    }
    return [];
  };
  const chain = dirsFromRootTo(gitRoot ?? cwd, cwd);
  const memory = [
    ...first(h, agentDir, "user"),
    ...chain.flatMap((d) => first(rootFor(d, h, r), d, "project")),
  ];
  const skills = [
    ...skillsIn(h, join(agentDir, "skills"), "pi", "user"),
    ...chain.flatMap((d) => [
      ...skillsIn(rootFor(d, h, r), join(d, ".pi", "skills"), "pi", "project"),
      ...skillsIn(rootFor(d, h, r), join(d, ".agents", "skills"), "pi", "project"),
    ]),
  ];
  return {
    memory: unique(memory, (f) => f.absolutePath),
    skills: unique(skills, (s) => s.file.absolutePath),
    subagents: [],
  };
}

/** Address files inside the project checkout relative to it, anything else relative to home. */
function rootFor(dir: string, home: ConfigRoot, project: ConfigRoot): ConfigRoot {
  return project.root === "project" && isInside(project.dir, dir) ? project : home;
}
