import { Liquid } from "liquidjs";
import YAML from "yaml";
import workflowText from "../WORKFLOW.md";
import type { GitHubIssue, LoadedWorkflow, WorkflowConfig } from "./types";
import { clampInteger } from "./util";

const FRONT_MATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
const PLACEHOLDERS = new Set(["OWNER", "REPOSITORY", "YOUR_ORG_OR_USER", "YOUR_REPOSITORY"]);
let cached: LoadedWorkflow | undefined;

interface RawWorkflow {
  tracker?: Record<string, unknown>;
  repository?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  sandbox?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
}

function strings(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`WORKFLOW.md: ${name} is required`);
  if (PLACEHOLDERS.has(result)) throw new Error(`WORKFLOW.md: ${name} still contains ${result}`);
  return result;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseConfig(raw: RawWorkflow): WorkflowConfig {
  const tracker = raw.tracker ?? {};
  const repository = raw.repository ?? {};
  const agent = raw.agent ?? {};
  const sandbox = raw.sandbox ?? {};
  const hooks = raw.hooks ?? {};

  const targetDir = String(repository.target_dir ?? "/workspace/repo");
  if (targetDir !== "/workspace" && !targetDir.startsWith("/workspace/")) {
    throw new Error("WORKFLOW.md: repository.target_dir must stay under /workspace");
  }

  const kind = String(tracker.kind ?? "github");
  if (kind !== "github") throw new Error(`WORKFLOW.md: unsupported tracker.kind ${kind}`);

  const owner = requiredString(tracker.owner, "tracker.owner");
  const repo = requiredString(tracker.repo, "tracker.repo");
  const activeStates = strings(tracker.active_states, ["open"]);
  const terminalStates = strings(tracker.terminal_states, ["closed"]);
  if (activeStates.length === 0) throw new Error("WORKFLOW.md: tracker.active_states cannot be empty");
  if (terminalStates.length === 0) throw new Error("WORKFLOW.md: tracker.terminal_states cannot be empty");

  const priorityLabels = strings(tracker.priority_labels, [
    "priority:urgent",
    "priority:high",
    "priority:medium",
    "priority:low",
  ]).slice(0, 4);

  const reasoning = optionalString(agent.reasoning_effort);
  const allowedReasoning = new Set(["minimal", "low", "medium", "high", "xhigh"]);
  if (reasoning && !allowedReasoning.has(reasoning)) {
    throw new Error(`WORKFLOW.md: unsupported agent.reasoning_effort ${reasoning}`);
  }

  return {
    tracker: {
      kind: "github",
      owner,
      repo,
      api_url: String(tracker.api_url ?? "https://api.github.com").replace(/\/$/, ""),
      api_version: String(tracker.api_version ?? "2022-11-28"),
      active_states: activeStates,
      terminal_states: terminalStates,
      required_labels: strings(tracker.required_labels),
      excluded_labels: strings(tracker.excluded_labels),
      blocked_labels: strings(tracker.blocked_labels, ["blocked"]),
      priority_labels: priorityLabels,
      assignee_login: optionalString(tracker.assignee_login),
      agent_logins: strings(tracker.agent_logins),
      use_issue_dependencies: boolean(tracker.use_issue_dependencies, true),
      poll_interval_ms: clampInteger(tracker.poll_interval_ms, 30_000, 5_000, 3_600_000),
    },
    repository: {
      clone_url:
        optionalString(repository.clone_url) ?? `https://github.com/${owner}/${repo}.git`,
      default_branch: String(repository.default_branch ?? "main"),
      target_dir: targetDir,
    },
    agent: {
      max_concurrent_agents: clampInteger(agent.max_concurrent_agents, 3, 1, 25),
      max_turns: clampInteger(agent.max_turns, 5, 1, 50),
      max_retry_attempts: clampInteger(agent.max_retry_attempts, 5, 0, 20),
      retry_base_ms: clampInteger(agent.retry_base_ms, 10_000, 1_000, 300_000),
      turn_timeout_ms: clampInteger(agent.turn_timeout_ms, 45 * 60_000, 60_000, 6 * 60 * 60_000),
      model: optionalString(agent.model),
      reasoning_effort: reasoning as WorkflowConfig["agent"]["reasoning_effort"],
    },
    sandbox: {
      sleep_after:
        typeof sandbox.sleep_after === "number"
          ? sandbox.sleep_after
          : String(sandbox.sleep_after ?? "15m"),
      backup_ttl_seconds: clampInteger(
        sandbox.backup_ttl_seconds,
        7 * 24 * 60 * 60,
        60,
        30 * 24 * 60 * 60,
      ),
    },
    hooks: {
      after_create: optionalString(hooks.after_create),
      before_run: optionalString(hooks.before_run),
      after_run: optionalString(hooks.after_run),
    },
  };
}

export function loadWorkflow(): LoadedWorkflow {
  if (cached) return cached;

  const match = workflowText.match(FRONT_MATTER);
  if (!match) throw new Error("WORKFLOW.md must contain YAML front matter between --- markers");

  const raw = (YAML.parse(match[1]) ?? {}) as RawWorkflow;
  const config = parseConfig(raw);
  const body = match[2].trim();
  const liquid = new Liquid({ strictVariables: true, strictFilters: true });
  const template = liquid.parse(body);

  cached = {
    config,
    async renderPrompt(issue: GitHubIssue, attempt: number): Promise<string> {
      return liquid.render(template, { issue, attempt });
    },
  };
  return cached;
}
