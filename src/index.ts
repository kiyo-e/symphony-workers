import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { Hono } from "hono";
import { loadWorkflow } from "./workflow";

export { ContainerProxy } from "@cloudflare/sandbox";
export { ProjectOrchestrator } from "./orchestrator";

export class Sandbox extends BaseSandbox<Env> {
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = [
    "api.cloudflare.com",
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
  ];
}

async function proxyRequest(
  request: Request,
  targetOrigin: string,
  mutateHeaders?: (headers: Headers) => void,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  mutateHeaders?.(headers);
  return fetch(`${targetOrigin}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "follow",
  });
}

Sandbox.outboundByHost = {
  "api.cloudflare.com": async (request: Request, env: Env): Promise<Response> =>
    proxyRequest(request, "https://api.cloudflare.com", (headers) => {
      headers.set("Authorization", `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
      headers.set("cf-aig-gateway-id", env.CLOUDFLARE_GATEWAY_ID);
      headers.delete("X-Api-Key");
    }),

  "github.com": async (request: Request, env: Env): Promise<Response> =>
    proxyRequest(request, "https://github.com", (headers) => {
      if (env.GITHUB_TOKEN && !headers.has("Authorization")) {
        headers.set("Authorization", `Basic ${btoa(`x-access-token:${env.GITHUB_TOKEN}`)}`);
      }
    }),

  "api.github.com": async (request: Request, env: Env): Promise<Response> =>
    proxyRequest(request, "https://api.github.com", (headers) => {
      if (env.GITHUB_TOKEN && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${env.GITHUB_TOKEN}`);
      }
      headers.set("Accept", "application/vnd.github+json");
      headers.set("X-GitHub-Api-Version", loadWorkflow().config.tracker.api_version);
      if (!headers.has("User-Agent")) headers.set("User-Agent", "symphony-cloudflare");
    }),
};

interface GitHubWebhookPayload {
  action?: string;
  zen?: string;
  repository?: { full_name?: string | null } | null;
}

interface VerifiedGitHubWebhook {
  body: GitHubWebhookPayload;
  event: string;
  deliveryId: string;
}

class WebhookError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WebhookError";
  }
}

const RELEVANT_ISSUE_ACTIONS = new Set([
  "opened",
  "edited",
  "deleted",
  "transferred",
  "closed",
  "reopened",
  "assigned",
  "unassigned",
  "labeled",
  "unlabeled",
  "milestoned",
  "demilestoned",
  "typed",
  "untyped",
]);

function orchestrator(env: Env) {
  return env.ORCHESTRATOR.getByName(env.PROJECT_KEY || "default");
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

async function verifyGitHubSignature(secret: string, signature: string, rawBody: string): Promise<boolean> {
  if (!signature.startsWith("sha256=")) return false;
  const signatureBytes = hexToBytes(signature.slice("sha256=".length));
  if (!signatureBytes) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(rawBody),
  );
}

async function verifyGitHubWebhook(request: Request, env: Env): Promise<VerifiedGitHubWebhook> {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    throw new WebhookError(500, "GITHUB_WEBHOOK_SECRET is not configured");
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!(await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, signature, rawBody))) {
    throw new WebhookError(401, "GitHub webhook signature mismatch");
  }

  const event = request.headers.get("x-github-event")?.trim() ?? "";
  const deliveryId = request.headers.get("x-github-delivery")?.trim() ?? "";
  if (!event || !deliveryId) throw new WebhookError(400, "Missing GitHub webhook headers");

  let body: GitHubWebhookPayload;
  try {
    body = JSON.parse(rawBody) as GitHubWebhookPayload;
  } catch {
    throw new WebhookError(400, "GitHub webhook body is not valid JSON");
  }
  const tracker = loadWorkflow().config.tracker;
  const expectedRepository = `${tracker.owner}/${tracker.repo}`.toLowerCase();
  const deliveredRepository = body.repository?.full_name?.toLowerCase();

  if (event !== "ping" && deliveredRepository !== expectedRepository) {
    throw new WebhookError(
      403,
      `Webhook repository mismatch: expected ${expectedRepository}, received ${deliveredRepository ?? "none"}`,
    );
  }
  if (event === "ping" && deliveredRepository && deliveredRepository !== expectedRepository) {
    throw new WebhookError(403, `Webhook ping repository mismatch: ${deliveredRepository}`);
  }

  return { body, event, deliveryId };
}

function shouldWakeOrchestrator(event: string, action: string | undefined): boolean {
  if (event === "issue_dependencies") return typeof action === "string" && action.length > 0;
  return event === "issues" && typeof action === "string" && RELEVANT_ISSUE_ACTIONS.has(action);
}

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", () => {
  const tracker = loadWorkflow().config.tracker;
  return Response.json({
    ok: true,
    service: "symphony-cloudflare-github",
    repository: `${tracker.owner}/${tracker.repo}`,
  });
});

app.post("/webhooks/github", async (c) => {
  try {
    const webhook = await verifyGitHubWebhook(c.req.raw, c.env);
    if (webhook.event === "ping") {
      return Response.json({ ok: true, event: "ping", zen: webhook.body.zen ?? null });
    }

    if (!shouldWakeOrchestrator(webhook.event, webhook.body.action)) {
      return Response.json(
        { ok: true, ignored: true, event: webhook.event, action: webhook.body.action ?? null },
        { status: 202 },
      );
    }

    c.executionCtx.waitUntil(
      orchestrator(c.env)
        .webhook(webhook.deliveryId, webhook.event, webhook.body.action)
        .catch((error) => console.error("GitHub webhook processing failed", error)),
    );
    return Response.json(
      { ok: true, accepted: true, deliveryId: webhook.deliveryId },
      { status: 202 },
    );
  } catch (error) {
    console.error("Invalid GitHub webhook", error);
    const status = error instanceof WebhookError ? error.status : 500;
    const message =
      status === 401
        ? "Unauthorized"
        : status === 403
          ? "Forbidden"
          : status === 400
            ? "Bad Request"
            : "Webhook processing is not configured";
    return new Response(message, { status });
  }
});

app.post("/tick", async (c) => {
  return Response.json(await orchestrator(c.env).tick("manual"));
});

app.get("/status", async (c) => {
  return Response.json(await orchestrator(c.env).status());
});

app.post("/jobs/:issueNumber/retry", async (c) => {
  return Response.json(await orchestrator(c.env).retry(c.req.param("issueNumber")));
});

app.post("/jobs/:issueNumber/cancel", async (c) => {
  return Response.json(await orchestrator(c.env).cancel(c.req.param("issueNumber")));
});

app.notFound(() => {
  return new Response("Not Found", { status: 404 });
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
