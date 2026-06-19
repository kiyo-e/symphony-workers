import { DurableObject } from "cloudflare:workers";
import { getSandbox, type DirectoryBackup, type Process as SandboxProcess } from "@cloudflare/sandbox";
import {
  GitHubClient,
  hasBlockingLabel,
  hasNonTerminalBlocker,
  isRoutable,
  sortForDispatch,
} from "./github";
import type {
  CodexProviderConfig,
  CompletedRecord,
  JobRecord,
  OrchestratorState,
  RunnerJob,
  RunnerResult,
  StatusSnapshot,
  WebhookReceipt,
  WorkflowConfig,
} from "./types";
import { loadWorkflow } from "./workflow";
import { errorMessage, runId, sandboxId, truncate } from "./util";

const STATE_KEY = "orchestrator-state-v2";
const STATUS_POLL_MS = 10_000;
const CONTINUATION_DELAY_MS = 1_000;
const COMPLETED_HISTORY_LIMIT = 50;
const RECENT_DELIVERY_LIMIT = 100;
const CODEX_HOME = "/workspace/.symphony/codex-home";
const CODEX_PROVIDER_ENV_KEY = "CLOUDFLARE_API_TOKEN";
const DEFAULT_CODEX_MODEL = "@cf/zai-org/glm-5.2";

function emptyState(): OrchestratorState {
  return { version: 2, jobs: {}, completed: [], recentDeliveries: [] };
}

function isProcessAlive(process: SandboxProcess | undefined): boolean {
  return process?.status === "starting" || process?.status === "running";
}

function backupRecord(backup: DirectoryBackup): Pick<DirectoryBackup, "id" | "dir"> {
  return { id: backup.id, dir: backup.dir };
}

function requiredEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is not configured`);
  return trimmed;
}

function codexProviderConfig(env: Env): CodexProviderConfig {
  const accountId = requiredEnv(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  requiredEnv(env.CLOUDFLARE_GATEWAY_ID, "CLOUDFLARE_GATEWAY_ID");
  requiredEnv(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");

  return {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    envKey: CODEX_PROVIDER_ENV_KEY,
    wireApi: "chat",
  };
}

export class ProjectOrchestrator extends DurableObject<Env> {
  private cyclePromise?: Promise<void>;
  private webhookQueue: Promise<void> = Promise.resolve();

  async tick(reason = "manual"): Promise<StatusSnapshot> {
    await this.serializedCycle(reason);
    return this.status();
  }

  async alarm(): Promise<void> {
    await this.serializedCycle("alarm");
  }

  async webhook(deliveryId: string, event: string, action?: string): Promise<WebhookReceipt> {
    const work = this.webhookQueue.then(async (): Promise<WebhookReceipt> => {
      const state = await this.loadState();
      if (state.recentDeliveries.includes(deliveryId)) {
        return { accepted: true, duplicate: true, deliveryId };
      }

      state.recentDeliveries = [deliveryId, ...state.recentDeliveries].slice(
        0,
        RECENT_DELIVERY_LIMIT,
      );
      state.lastWebhookAt = Date.now();
      state.lastWebhookEvent = action ? `${event}:${action}` : event;
      await this.saveState(state);
      await this.serializedCycle(`github-webhook:${state.lastWebhookEvent}`);
      return { accepted: true, duplicate: false, deliveryId };
    });

    this.webhookQueue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  async status(): Promise<StatusSnapshot> {
    const state = await this.loadState();
    const jobs = Object.values(state.jobs);
    return {
      projectKey: this.env.PROJECT_KEY,
      repository: `${loadWorkflow().config.tracker.owner}/${loadWorkflow().config.tracker.repo}`,
      lastWebhookAt: state.lastWebhookAt,
      lastWebhookEvent: state.lastWebhookEvent,
      lastCycleAt: state.lastCycleAt,
      nextAlarmAt: state.nextAlarmAt,
      lastError: state.lastError,
      running: jobs.filter((job) => job.phase === "running" || job.phase === "starting").length,
      waiting: jobs.filter((job) => job.phase === "waiting").length,
      blocked: jobs.filter((job) => job.phase === "blocked").length,
      jobs: jobs
        .map((job) => ({
          issueId: job.issue.id,
          issueNumber: job.issue.number,
          identifier: job.issue.identifier,
          title: job.issue.title,
          state: job.issue.state,
          phase: job.phase,
          waitKind: job.waitKind,
          sandboxId: job.sandboxId,
          turn: job.turn,
          attempt: job.attempt,
          threadId: job.threadId,
          startedAt: job.startedAt,
          nextRunAt: job.nextRunAt,
          lastError: job.lastError,
          backup: job.backup,
        }))
        .sort((left, right) => left.identifier.localeCompare(right.identifier)),
      completed: state.completed,
    };
  }

  async retry(issueId: string): Promise<StatusSnapshot> {
    const state = await this.loadState();
    const job = state.jobs[issueId];
    if (!job) throw new Error(`Unknown issue id: ${issueId}`);
    if (job.phase !== "blocked") throw new Error(`Issue ${job.issue.identifier} is not blocked`);

    job.phase = "waiting";
    job.waitKind = "retry";
    job.nextRunAt = Date.now();
    job.attempt = 1;
    job.lastError = undefined;
    job.restoreOnStart = Boolean(job.backup);
    await this.saveState(state);
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return this.status();
  }

  async cancel(issueId: string): Promise<StatusSnapshot> {
    const state = await this.loadState();
    const job = state.jobs[issueId];
    if (!job) throw new Error(`Unknown issue id: ${issueId}`);
    await this.finishJob(state, job, "cancelled", loadWorkflow().config, true);
    await this.saveState(state);
    return this.status();
  }

  private async serializedCycle(reason: string): Promise<void> {
    if (!this.cyclePromise) {
      this.cyclePromise = this.runCycle(reason).finally(() => {
        this.cyclePromise = undefined;
      });
    }
    await this.cyclePromise;
  }

  private async runCycle(reason: string): Promise<void> {
    const workflow = loadWorkflow();
    const config = workflow.config;
    const state = await this.loadState();
    state.lastCycleAt = Date.now();

    const cycleErrors: string[] = [];
    try {
      await this.inspectRunningJobs(state, config);
    } catch (error) {
      cycleErrors.push(`sandbox reconciliation: ${errorMessage(error)}`);
    }

    try {
      const github = new GitHubClient(this.env.GITHUB_TOKEN, config.tracker);
      await this.reconcileTrackedIssues(state, github, config);
      await this.startDueJobs(state, workflow, config);
      await this.dispatchCandidates(state, github, workflow, config);
    } catch (error) {
      cycleErrors.push(`tracker reconciliation: ${errorMessage(error)}`);
    }

    state.lastError = cycleErrors.length > 0 ? `${reason}: ${cycleErrors.join(" | ")}` : undefined;
    if (state.lastError) {
      console.error("Symphony orchestration cycle failed", { reason, error: state.lastError });
    }

    await this.scheduleNextAlarm(state, config);
    await this.saveState(state);
  }

  private async reconcileTrackedIssues(
    state: OrchestratorState,
    github: GitHubClient,
    config: WorkflowConfig,
  ): Promise<void> {
    const ids = Object.keys(state.jobs);
    if (ids.length === 0) return;

    const visible = new Map((await github.fetchByIds(ids)).map((issue) => [issue.id, issue]));
    for (const issueId of ids) {
      const job = state.jobs[issueId];
      const refreshed = visible.get(issueId);
      if (!refreshed) {
        await this.finishJob(state, job, "missing", config, true);
        continue;
      }

      job.issue = refreshed;
      if (!isRoutable(refreshed, config.tracker)) {
        const outcome = config.tracker.terminal_states.some(
          (stateName) => stateName.trim().toLowerCase() === refreshed.state.trim().toLowerCase(),
        )
          ? "terminal"
          : "unroutable";
        await this.finishJob(state, job, outcome, config, true);
      }
    }
  }

  private async inspectRunningJobs(state: OrchestratorState, config: WorkflowConfig): Promise<void> {
    for (const job of Object.values(state.jobs)) {
      if (job.phase !== "running" && job.phase !== "starting") continue;

      const sandbox = getSandbox(this.env.Sandbox, job.sandboxId, {
        keepAlive: true,
        sleepAfter: config.sandbox.sleep_after,
      });

      let process: SandboxProcess | undefined;
      try {
        process = (await sandbox.listProcesses()).find((candidate) => candidate.id === job.processId);
      } catch (error) {
        await this.handleFailure(state, job, config, `sandbox unavailable: ${errorMessage(error)}`);
        continue;
      }

      const elapsed = job.startedAt ? Date.now() - job.startedAt : 0;
      if (isProcessAlive(process) && elapsed <= config.agent.turn_timeout_ms) {
        job.phase = "running";
        continue;
      }

      if (isProcessAlive(process) && elapsed > config.agent.turn_timeout_ms) {
        try {
          await process?.kill("SIGTERM");
        } catch {
          // The retry path below will destroy the sandbox as a final cleanup.
        }
        await this.handleFailure(
          state,
          job,
          config,
          `Codex turn timed out after ${config.agent.turn_timeout_ms}ms`,
        );
        continue;
      }

      const result = await this.readRunnerResult(sandbox, job.resultPath);
      if (result?.ok) {
        job.threadId = result.threadId ?? job.threadId;
        job.turn += 1;
        job.attempt = 1;
        job.lastResponse = truncate(result.finalResponse);
        job.lastUsage = result.usage;
        job.lastError = undefined;
        job.processId = undefined;
        job.phase = "waiting";
        job.waitKind = "continuation";
        job.nextRunAt = Date.now() + CONTINUATION_DELAY_MS;
        job.backup = await this.backupWorkspace(job, config);
        job.restoreOnStart = false;
        continue;
      }

      let processLogs = "";
      try {
        const logs = await process?.getLogs();
        processLogs = truncate(`${logs?.stderr ?? ""}\n${logs?.stdout ?? ""}`, 4_000) ?? "";
      } catch {
        // Result-file errors are sufficient if logs are unavailable.
      }
      const reason = result?.error ?? (processLogs || `Codex process ${process?.status ?? "disappeared"}`);
      await this.handleFailure(state, job, config, reason);
    }
  }

  private async startDueJobs(
    state: OrchestratorState,
    workflow: ReturnType<typeof loadWorkflow>,
    config: WorkflowConfig,
  ): Promise<void> {
    const due = Object.values(state.jobs)
      .filter((job) => job.phase === "waiting" && (job.nextRunAt ?? 0) <= Date.now())
      .sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0));

    for (const job of due) {
      if (this.runningCount(state) >= config.agent.max_concurrent_agents) break;
      if (job.waitKind === "continuation" && job.turn >= config.agent.max_turns) {
        await this.blockJob(job, config, `agent.max_turns (${config.agent.max_turns}) reached`);
        continue;
      }
      await this.startTurn(state, job, workflow, config);
    }
  }

  private async dispatchCandidates(
    state: OrchestratorState,
    github: GitHubClient,
    workflow: ReturnType<typeof loadWorkflow>,
    config: WorkflowConfig,
  ): Promise<void> {
    if (this.runningCount(state) >= config.agent.max_concurrent_agents) return;

    const candidates = sortForDispatch(await github.fetchCandidates());
    for (const issue of candidates) {
      if (this.runningCount(state) >= config.agent.max_concurrent_agents) break;
      if (state.jobs[issue.id]) continue;
      if (!isRoutable(issue, config.tracker) || hasBlockingLabel(issue, config.tracker)) continue;

      const candidate = await github.populateBlockers(issue);
      if (hasNonTerminalBlocker(candidate, config.tracker)) continue;

      const job: JobRecord = {
        issue: candidate,
        sandboxId: sandboxId(this.env.PROJECT_KEY, issue.id, issue.identifier),
        phase: "waiting",
        waitKind: "retry",
        turn: 0,
        attempt: 1,
        restoreOnStart: false,
        nextRunAt: Date.now(),
      };
      state.jobs[issue.id] = job;
      await this.saveState(state);
      await this.startTurn(state, job, workflow, config);
    }
  }

  private async startTurn(
    state: OrchestratorState,
    job: JobRecord,
    workflow: ReturnType<typeof loadWorkflow>,
    config: WorkflowConfig,
  ): Promise<void> {
    const nextTurn = job.turn + 1;
    const id = runId(job.issue.identifier, nextTurn, job.attempt);
    const resultPath = `/workspace/.symphony/${id}.result.json`;
    const eventsPath = `/workspace/.symphony/${id}.events.jsonl`;
    const jobPath = `/workspace/.symphony/${id}.job.json`;

    job.runId = id;
    job.processId = `codex-${id}`;
    job.resultPath = resultPath;
    job.eventsPath = eventsPath;
    job.phase = "starting";
    job.startedAt = Date.now();
    job.lastActivityAt = job.startedAt;
    job.nextRunAt = undefined;
    await this.saveState(state);

    try {
      const codexProvider = codexProviderConfig(this.env);
      const sandbox = getSandbox(this.env.Sandbox, job.sandboxId, {
        keepAlive: true,
        sleepAfter: config.sandbox.sleep_after,
      });
      await sandbox.setKeepAlive(true);
      await sandbox.setEnvVars({
        [codexProvider.envKey]: "proxy-injected",
        CODEX_HOME,
      });

      if (job.restoreOnStart && job.backup) {
        await sandbox.restoreBackup(job.backup);
        job.restoreOnStart = false;
      }

      await sandbox.mkdir("/workspace/.symphony", { recursive: true });
      const initialPrompt = await workflow.renderPrompt(job.issue, job.attempt);
      const prompt = job.threadId
        ? [
            `Continue the existing implementation run for ${job.issue.identifier}.`,
            "The GitHub issue is still open and routable. Resume from the current workspace and thread context.",
            "Run the relevant checks and finish the remaining work. Do not merely restate prior progress.",
          ].join("\n")
        : initialPrompt;

      const runnerJob: RunnerJob = {
        runId: id,
        issue: job.issue,
        repository: config.repository,
        hooks: config.hooks,
        prompt,
        threadId: job.threadId,
        model: config.agent.model ?? DEFAULT_CODEX_MODEL,
        codexProvider,
        reasoningEffort: config.agent.reasoning_effort,
        resultPath,
        eventsPath,
      };
      await sandbox.writeFile(jobPath, JSON.stringify(runnerJob));
      await sandbox.startProcess(`node /opt/symphony-runner/run.mjs ${jobPath}`, {
        processId: job.processId,
        cwd: "/workspace",
        autoCleanup: false,
        env: { [codexProvider.envKey]: "proxy-injected", CODEX_HOME },
      });
      job.phase = "running";
      await this.saveState(state);
    } catch (error) {
      await this.handleFailure(state, job, config, `failed to start Codex: ${errorMessage(error)}`);
    }
  }

  private async handleFailure(
    state: OrchestratorState,
    job: JobRecord,
    config: WorkflowConfig,
    reason: string,
  ): Promise<void> {
    job.lastError = truncate(reason, 8_000);
    job.processId = undefined;
    job.backup = await this.backupWorkspace(job, config);

    try {
      const sandbox = getSandbox(this.env.Sandbox, job.sandboxId);
      await sandbox.destroy();
    } catch {
      // The next getSandbox call will recreate the container if needed.
    }
    job.restoreOnStart = Boolean(job.backup);

    if (job.attempt > config.agent.max_retry_attempts) {
      await this.blockJob(
        job,
        config,
        `retry limit reached: ${job.lastError ?? "unknown error"}`,
        false,
      );
      return;
    }

    const delay = Math.min(
      config.agent.retry_base_ms * 2 ** Math.max(0, job.attempt - 1),
      5 * 60_000,
    );
    job.attempt += 1;
    job.phase = "waiting";
    job.waitKind = "retry";
    job.nextRunAt = Date.now() + delay;
    await this.saveState(state);
  }

  private async blockJob(
    job: JobRecord,
    config: WorkflowConfig,
    reason: string,
    createBackup = true,
  ): Promise<void> {
    job.phase = "blocked";
    job.waitKind = undefined;
    job.nextRunAt = undefined;
    job.processId = undefined;
    job.lastError = reason;
    if (createBackup) {
      job.backup = await this.backupWorkspace(job, config);
      try {
        const sandbox = getSandbox(this.env.Sandbox, job.sandboxId);
        await sandbox.destroy();
      } catch {
        // Preserve the blocked state even if teardown fails.
      }
    }
    job.restoreOnStart = Boolean(job.backup);
  }

  private async finishJob(
    state: OrchestratorState,
    job: JobRecord,
    outcome: CompletedRecord["outcome"],
    config: WorkflowConfig,
    preserveWorkspace: boolean,
  ): Promise<void> {
    const sandbox = getSandbox(this.env.Sandbox, job.sandboxId);
    if (job.processId) {
      try {
        const process = (await sandbox.listProcesses()).find((candidate) => candidate.id === job.processId);
        if (isProcessAlive(process)) await process?.kill("SIGTERM");
      } catch {
        // Teardown below remains authoritative.
      }
    }

    if (preserveWorkspace) job.backup = await this.backupWorkspace(job, config);
    try {
      await sandbox.destroy();
    } catch {
      // State cleanup must not depend on container teardown succeeding.
    }

    state.completed.unshift({
      issueId: job.issue.id,
      identifier: job.issue.identifier,
      outcome,
      completedAt: Date.now(),
      threadId: job.threadId,
      backup: job.backup,
      lastResponse: job.lastResponse,
    });
    state.completed = state.completed.slice(0, COMPLETED_HISTORY_LIMIT);
    delete state.jobs[job.issue.id];
  }

  private async backupWorkspace(
    job: JobRecord,
    config: WorkflowConfig,
  ): Promise<Pick<DirectoryBackup, "id" | "dir"> | undefined> {
    if (job.restoreOnStart && job.backup) return job.backup;
    try {
      const sandbox = getSandbox(this.env.Sandbox, job.sandboxId, {
        keepAlive: true,
        sleepAfter: config.sandbox.sleep_after,
      });
      const backup = await sandbox.createBackup({
        dir: "/workspace",
        name: `${job.issue.identifier}-turn-${job.turn}-attempt-${job.attempt}`,
        ttl: config.sandbox.backup_ttl_seconds,
      });
      return backupRecord(backup);
    } catch (error) {
      console.warn("Workspace backup failed", {
        issue: job.issue.identifier,
        error: errorMessage(error),
      });
      return job.backup;
    }
  }

  private async readRunnerResult(
    sandbox: ReturnType<typeof getSandbox>,
    path: string | undefined,
  ): Promise<RunnerResult | undefined> {
    if (!path) return undefined;
    try {
      const file = await sandbox.readFile(path);
      return JSON.parse(file.content) as RunnerResult;
    } catch {
      return undefined;
    }
  }

  private runningCount(state: OrchestratorState): number {
    return Object.values(state.jobs).filter(
      (job) => job.phase === "running" || job.phase === "starting",
    ).length;
  }

  private async scheduleNextAlarm(state: OrchestratorState, config: WorkflowConfig): Promise<void> {
    const now = Date.now();
    let delay = config.tracker.poll_interval_ms;
    if (this.runningCount(state) > 0) delay = Math.min(delay, STATUS_POLL_MS);

    for (const job of Object.values(state.jobs)) {
      if (job.phase === "waiting" && job.nextRunAt) {
        delay = Math.min(delay, Math.max(1_000, job.nextRunAt - now));
      }
    }

    state.nextAlarmAt = now + Math.max(1_000, delay);
    await this.ctx.storage.setAlarm(state.nextAlarmAt);
  }

  private async loadState(): Promise<OrchestratorState> {
    return (await this.ctx.storage.get<OrchestratorState>(STATE_KEY)) ?? emptyState();
  }

  private async saveState(state: OrchestratorState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }
}
