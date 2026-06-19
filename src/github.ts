import type { GitHubIssue, GitHubIssueComment, GitHubIssueRef, WorkflowConfig } from "./types";
import { fnv1a, normalize, truncate } from "./util";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type GitHubLabel = string | { name?: string | null };

interface GitHubApiIssue {
  id?: number;
  node_id?: string | null;
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  state_reason?: string | null;
  html_url?: string | null;
  repository_url?: string | null;
  labels?: GitHubLabel[];
  assignee?: { login?: string | null } | null;
  assignees?: Array<{ login?: string | null }> | null;
  created_at?: string | null;
  updated_at?: string | null;
  pull_request?: unknown;
}

interface GitHubApiIssueComment {
  id?: number;
  body?: string | null;
  html_url?: string | null;
  user?: { login?: string | null } | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface GitHubErrorPayload {
  message?: string;
  documentation_url?: string;
}

export class GitHubClient {
  constructor(
    private readonly token: string | undefined,
    private readonly config: WorkflowConfig["tracker"],
  ) {}

  get repository(): string {
    return `${this.config.owner}/${this.config.repo}`;
  }

  async fetchCandidates(): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    const state = candidateApiState(this.config.active_states);

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        state,
        sort: "created",
        direction: "asc",
        per_page: String(PAGE_SIZE),
        page: String(page),
      });
      if (this.config.required_labels.length > 0) {
        params.set("labels", this.config.required_labels.join(","));
      }

      const raw = await this.request<GitHubApiIssue[]>(
        `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/issues?${params}`,
      );
      const normalized = raw
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => normalizeIssue(issue, this.config))
        .filter((issue): issue is GitHubIssue => issue !== null);
      issues.push(...normalized);

      if (raw.length < PAGE_SIZE) return issues;
    }

    throw new Error(
      `GitHub issue pagination exceeded ${MAX_PAGES * PAGE_SIZE} records for ${this.repository}`,
    );
  }

  async fetchByIds(ids: string[]): Promise<GitHubIssue[]> {
    const numbers = [...new Set(ids)]
      .map((id) => Number.parseInt(id, 10))
      .filter((number) => Number.isSafeInteger(number) && number > 0);

    const issues = await Promise.all(
      numbers.map(async (number) => {
        const raw = await this.request<GitHubApiIssue | undefined>(
          `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/issues/${number}`,
          { allowNotFound: true },
        );
        if (!raw || raw.pull_request !== undefined) return null;
        return normalizeIssue(raw, this.config);
      }),
    );

    return issues.filter((issue): issue is GitHubIssue => issue !== null);
  }

  async fetchWithComments(issue: GitHubIssue): Promise<GitHubIssue> {
    const raw = await this.request<GitHubApiIssue | undefined>(
      `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}` +
        `/issues/${issue.number}`,
      { allowNotFound: true },
    );
    if (!raw || raw.pull_request !== undefined) return issue;
    const refreshed = normalizeIssue(raw, this.config);
    if (!refreshed) return issue;
    return { ...refreshed, comments: await this.fetchComments(issue.number) };
  }

  async fetchComments(issueNumber: number): Promise<GitHubIssueComment[]> {
    const comments: GitHubIssueComment[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        per_page: String(PAGE_SIZE),
        page: String(page),
      });
      const raw = await this.request<GitHubApiIssueComment[]>(
        `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}` +
          `/issues/${issueNumber}/comments?${params}`,
      );
      comments.push(...raw.map(normalizeComment).filter((comment): comment is GitHubIssueComment => comment !== null));
      if (raw.length < PAGE_SIZE) return comments;
    }

    throw new Error(`GitHub issue comment pagination exceeded for #${issueNumber}`);
  }

  async populateBlockers(issue: GitHubIssue): Promise<GitHubIssue> {
    if (!this.config.use_issue_dependencies) return issue;

    const blockedBy: GitHubIssueRef[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page) });
      const raw = await this.request<GitHubApiIssue[]>(
        `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}` +
          `/issues/${issue.number}/dependencies/blocked_by?${params}`,
      );
      blockedBy.push(
        ...raw
          .map((dependency) => normalizeIssueRef(dependency, this.repository))
          .filter((dependency): dependency is GitHubIssueRef => dependency !== null),
      );
      if (raw.length < PAGE_SIZE) return { ...issue, blockedBy };
    }

    throw new Error(`GitHub dependency pagination exceeded for ${issue.identifier}`);
  }

  private async request<T>(
    path: string,
    options: { allowNotFound?: boolean } = {},
  ): Promise<T> {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": this.config.api_version,
      "User-Agent": "symphony-cloudflare",
    });
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);

    const response = await fetch(`${this.config.api_url.replace(/\/$/, "")}${path}`, {
      headers,
    });
    if (response.status === 404 && options.allowNotFound) return undefined as T;
    if (!response.ok) {
      const responseText = await response.text();
      let detail = responseText ? `: ${responseText.slice(0, 500)}` : "";
      try {
        const payload = JSON.parse(responseText) as GitHubErrorPayload;
        detail = payload.message ? `: ${payload.message}` : detail;
      } catch {
        // Keep the truncated response text when GitHub did not return JSON.
      }
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      const rate = remaining !== null ? ` rate_remaining=${remaining} rate_reset=${reset ?? "unknown"}` : "";
      throw new Error(`GitHub API ${response.status}${detail}${rate}`);
    }
    return (await response.json()) as T;
  }
}

function repositoryFromApiUrl(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const match = value.match(/\/repos\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? fallback;
}

function labelNames(labels: GitHubLabel[] | undefined): string[] {
  return (labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name ?? ""))
    .map((label) => label.trim())
    .filter(Boolean);
}

function assigneeLogins(raw: GitHubApiIssue): string[] {
  const values = [raw.assignee?.login, ...(raw.assignees ?? []).map((assignee) => assignee.login)];
  return [...new Set(values.filter((login): login is string => Boolean(login)).map((login) => login.trim()))];
}

function normalizeIssue(raw: GitHubApiIssue, config: WorkflowConfig["tracker"]): GitHubIssue | null {
  if (!Number.isSafeInteger(raw.number) || !raw.number || !raw.title || !raw.state) return null;

  const repository = repositoryFromApiUrl(raw.repository_url, `${config.owner}/${config.repo}`);
  const labels = labelNames(raw.labels);
  const assignees = assigneeLogins(raw);
  const priorityIndex = config.priority_labels.findIndex((priorityLabel) =>
    labels.some((label) => normalize(label) === normalize(priorityLabel)),
  );

  return {
    id: String(raw.number),
    nodeId: raw.node_id ?? null,
    number: raw.number,
    repository,
    identifier: `${repository}#${raw.number}`,
    title: raw.title,
    description: raw.body ?? "",
    priority: priorityIndex >= 0 ? priorityIndex + 1 : null,
    state: raw.state,
    stateReason: raw.state_reason ?? null,
    branchName: null,
    url: raw.html_url ?? null,
    assigneeLogin: assignees[0] ?? null,
    assigneeLogins: assignees,
    labels,
    comments: [],
    blockedBy: [],
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}

function normalizeComment(raw: GitHubApiIssueComment): GitHubIssueComment | null {
  if (!Number.isSafeInteger(raw.id) || !raw.id) return null;
  return {
    id: raw.id,
    authorLogin: raw.user?.login ?? null,
    body: truncate(raw.body ?? "", 8_000) ?? "",
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
    url: raw.html_url ?? null,
  };
}

function actorSet(agentLogins: string[]): Set<string> {
  return new Set(agentLogins.map(normalize).filter(Boolean));
}

export function isIgnoredActor(login: string | null | undefined, agentLogins: string[]): boolean {
  const normalized = normalize(login);
  if (!normalized) return false;
  return actorSet(agentLogins).has(normalized) || normalized.endsWith("[bot]");
}

export function actionableComments(
  comments: GitHubIssueComment[],
  agentLogins: string[],
): GitHubIssueComment[] {
  return comments.filter((comment) => !isIgnoredActor(comment.authorLogin, agentLogins));
}

export function contextFingerprint(issue: GitHubIssue, agentLogins: string[]): string {
  const payload = {
    title: issue.title,
    description: issue.description,
    state: issue.state,
    labels: issue.labels.map(normalize).sort(),
    assignees: issue.assigneeLogins.map(normalize).sort(),
    comments: actionableComments(issue.comments, agentLogins).map((comment) => ({
      id: comment.id,
      authorLogin: normalize(comment.authorLogin),
      body: comment.body,
      updatedAt: comment.updatedAt,
    })),
  };
  return fnv1a(JSON.stringify(payload));
}

function normalizeIssueRef(raw: GitHubApiIssue, fallbackRepository: string): GitHubIssueRef | null {
  if (!Number.isSafeInteger(raw.number) || !raw.number || !raw.state) return null;
  const repository = repositoryFromApiUrl(raw.repository_url, fallbackRepository);
  return {
    id: `${repository}#${raw.number}`,
    number: raw.number,
    identifier: `${repository}#${raw.number}`,
    state: raw.state,
  };
}

function candidateApiState(activeStates: string[]): "open" | "closed" | "all" {
  const values = new Set(activeStates.map(normalize));
  if (values.size === 1 && values.has("closed")) return "closed";
  if (values.size === 1 && values.has("open")) return "open";
  return "all";
}

export function isActive(issue: GitHubIssue, config: WorkflowConfig["tracker"]): boolean {
  const active = new Set(config.active_states.map(normalize));
  return active.has(normalize(issue.state));
}

export function isTerminalState(state: string, config: WorkflowConfig["tracker"]): boolean {
  const terminal = new Set(config.terminal_states.map(normalize));
  return terminal.has(normalize(state));
}

export function isRoutable(issue: GitHubIssue, config: WorkflowConfig["tracker"]): boolean {
  if (!isActive(issue, config)) return false;
  if (
    config.assignee_login &&
    !issue.assigneeLogins.some((login) => normalize(login) === normalize(config.assignee_login))
  ) {
    return false;
  }

  const issueLabels = new Set(issue.labels.map(normalize));
  if (!config.required_labels.every((label) => issueLabels.has(normalize(label)))) return false;
  const routingBlockers = [...config.excluded_labels, ...config.blocked_labels];
  return !routingBlockers.some((label) => issueLabels.has(normalize(label)));
}

export function hasBlockingLabel(issue: GitHubIssue, config: WorkflowConfig["tracker"]): boolean {
  const issueLabels = new Set(issue.labels.map(normalize));
  return config.blocked_labels.some((label) => issueLabels.has(normalize(label)));
}

export function hasNonTerminalBlocker(
  issue: GitHubIssue,
  config: WorkflowConfig["tracker"],
): boolean {
  return issue.blockedBy.some((blocker) => !isTerminalState(blocker.state, config));
}

export function sortForDispatch(issues: GitHubIssue[]): GitHubIssue[] {
  const priorityRank = (priority: number | null): number =>
    priority !== null && priority >= 1 && priority <= 4 ? priority : 5;
  const createdAt = (issue: GitHubIssue): number => {
    const value = issue.createdAt ? Date.parse(issue.createdAt) : Number.MAX_SAFE_INTEGER;
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };

  return [...issues].sort((left, right) => {
    return (
      priorityRank(left.priority) - priorityRank(right.priority) ||
      createdAt(left) - createdAt(right) ||
      left.identifier.localeCompare(right.identifier)
    );
  });
}
