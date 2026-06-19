import type { DirectoryBackup } from "@cloudflare/sandbox";

export interface GitHubIssueRef {
  id: string;
  number: number;
  identifier: string;
  state: string;
}

export interface GitHubIssue {
  /** Repository-scoped stable key. This is the issue number encoded as a string. */
  id: string;
  nodeId: string | null;
  number: number;
  repository: string;
  identifier: string;
  title: string;
  description: string;
  priority: number | null;
  state: string;
  stateReason: string | null;
  branchName: string | null;
  url: string | null;
  assigneeLogin: string | null;
  assigneeLogins: string[];
  labels: string[];
  blockedBy: GitHubIssueRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkflowConfig {
  tracker: {
    kind: "github";
    owner: string;
    repo: string;
    api_url: string;
    api_version: string;
    active_states: string[];
    terminal_states: string[];
    required_labels: string[];
    excluded_labels: string[];
    blocked_labels: string[];
    priority_labels: string[];
    assignee_login?: string;
    use_issue_dependencies: boolean;
    poll_interval_ms: number;
  };
  repository: {
    clone_url: string;
    default_branch: string;
    target_dir: string;
  };
  agent: {
    max_concurrent_agents: number;
    max_turns: number;
    max_retry_attempts: number;
    retry_base_ms: number;
    turn_timeout_ms: number;
    model?: string;
    reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  };
  sandbox: {
    sleep_after: string | number;
    backup_ttl_seconds: number;
  };
  hooks: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
  };
}

export interface LoadedWorkflow {
  config: WorkflowConfig;
  renderPrompt(issue: GitHubIssue, attempt: number): Promise<string>;
}

export type JobPhase = "starting" | "running" | "waiting" | "blocked";
export type WaitKind = "retry" | "continuation";

export interface AgentProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  envKey: string;
  httpHeaders?: Record<string, string>;
}

export interface JobRecord {
  issue: GitHubIssue;
  sandboxId: string;
  phase: JobPhase;
  waitKind?: WaitKind;
  processId?: string;
  runId?: string;
  resultPath?: string;
  eventsPath?: string;
  turn: number;
  attempt: number;
  threadId?: string;
  backup?: Pick<DirectoryBackup, "id" | "dir">;
  restoreOnStart: boolean;
  startedAt?: number;
  lastActivityAt?: number;
  nextRunAt?: number;
  lastError?: string;
  lastResponse?: string;
  lastUsage?: unknown;
}

export interface CompletedRecord {
  issueId: string;
  identifier: string;
  outcome: "terminal" | "unroutable" | "missing" | "cancelled";
  completedAt: number;
  threadId?: string;
  backup?: Pick<DirectoryBackup, "id" | "dir">;
  lastResponse?: string;
}

export interface OrchestratorState {
  version: 2;
  jobs: Record<string, JobRecord>;
  completed: CompletedRecord[];
  recentDeliveries: string[];
  lastWebhookAt?: number;
  lastWebhookEvent?: string;
  lastCycleAt?: number;
  nextAlarmAt?: number;
  lastError?: string;
}

export interface RunnerJob {
  runId: string;
  issue: GitHubIssue;
  repository: WorkflowConfig["repository"];
  hooks: WorkflowConfig["hooks"];
  prompt: string;
  threadId?: string;
  model?: string;
  agentProvider?: AgentProviderConfig;
  reasoningEffort?: WorkflowConfig["agent"]["reasoning_effort"];
  resultPath: string;
  eventsPath: string;
}

export interface RunnerResult {
  ok: boolean;
  runId: string;
  threadId?: string;
  finalResponse?: string;
  usage?: unknown;
  error?: string;
  stderrTail?: string;
  completedAt: string;
}

export interface WebhookReceipt {
  accepted: boolean;
  duplicate: boolean;
  deliveryId: string;
}

export interface JobLogsSnapshot {
  issueId: string;
  issueNumber: number;
  identifier: string;
  phase: JobPhase;
  waitKind?: WaitKind;
  sandboxId: string;
  processId?: string;
  runId?: string;
  resultPath?: string;
  eventsPath?: string;
  stdout?: string;
  stderr?: string;
  events?: string;
  result?: RunnerResult;
}

export interface StatusSnapshot {
  projectKey: string;
  repository: string;
  lastWebhookAt?: number;
  lastWebhookEvent?: string;
  lastCycleAt?: number;
  nextAlarmAt?: number;
  lastError?: string;
  running: number;
  waiting: number;
  blocked: number;
  jobs: Array<{
    issueId: string;
    issueNumber: number;
    identifier: string;
    title: string;
    state: string;
    phase: JobPhase;
    waitKind?: WaitKind;
    sandboxId: string;
    turn: number;
    attempt: number;
    threadId?: string;
    startedAt?: number;
    nextRunAt?: number;
    lastError?: string;
    backup?: Pick<DirectoryBackup, "id" | "dir">;
  }>;
  completed: CompletedRecord[];
}
