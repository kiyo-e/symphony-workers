import { spawn } from "node:child_process";
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_CAPTURE_BYTES = 512_000;
const jobPath = process.argv[2];
if (!jobPath) {
  console.error("Usage: node run.mjs <job.json>");
  process.exit(2);
}

const job = JSON.parse(await readFile(jobPath, "utf8"));
let threadId = job.threadId;
let finalResponse = "";
let usage;
let stderrCapture = "";
let eventBuffer = "";
let eventWriteChain = Promise.resolve();

function underWorkspace(target) {
  const resolved = path.resolve(target);
  if (resolved !== "/workspace" && !resolved.startsWith("/workspace/")) {
    throw new Error(`Path escapes /workspace: ${target}`);
  }
  return resolved;
}

function capture(existing, chunk) {
  const next = existing + chunk;
  return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(-MAX_CAPTURE_BYTES);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: [options.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", async (chunk) => {
      stdout = capture(stdout, chunk);
      if (options.onStdout) options.onStdout(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
      stderrCapture = capture(stderrCapture, chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });

    if (options.stdinText !== undefined) {
      child.stdin.end(options.stdinText);
    }
  });
}

async function runHook(name, command, cwd) {
  if (!command) return;
  const result = await run("bash", ["-lc", command], { cwd });
  if (result.code !== 0) {
    throw new Error(`${name} hook failed (${result.code}): ${result.stderr || result.stdout}`);
  }
}

function consumeEventLine(line) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    const sessionId =
      event.session?.id ??
      event.sessionID ??
      event.session_id ??
      event.sessionId;
    if (typeof sessionId === "string" && sessionId) threadId = sessionId;
    if (typeof event.text === "string") finalResponse = event.text;
    if (typeof event.message === "string") finalResponse = event.message;
    if (event.type === "message" && typeof event.content === "string") finalResponse = event.content;
    if (event.type === "session.updated" && event.session?.usage) usage = event.session.usage;
    if (event.type === "run.completed" && event.usage) usage = event.usage;
  } catch {
    // The complete raw stream remains available for diagnostics.
  }
}

async function appendAgentEvents(chunk) {
  await appendFile(job.eventsPath, chunk, "utf8");
  eventBuffer += chunk;
  const lines = eventBuffer.split("\n");
  eventBuffer = lines.pop() ?? "";
  for (const line of lines) consumeEventLine(line);
}

function queueAgentEvents(chunk) {
  eventWriteChain = eventWriteChain.then(() => appendAgentEvents(chunk));
  eventWriteChain.catch((error) => console.error("agent event write failed", error));
}

function normalizeOpenCodeModel(model, providerId) {
  if (!model) return undefined;
  if (model.startsWith(`${providerId}/`)) return model;
  if (model.startsWith("@cf/")) return `${providerId}/${model}`;
  return model;
}

function openCodeModelId(model, providerId) {
  const prefix = `${providerId}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

async function writeOpenCodeConfig(configPath, provider, model) {
  if (!provider || !model) return;
  const modelId = openCodeModelId(model, provider.id);
  await writeFile(
    configPath,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model,
        provider: {
          [provider.id]: {
            models: {
              [modelId]: { name: modelId },
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function atomicResult(result) {
  const tempPath = `${job.resultPath}.tmp`;
  await writeFile(tempPath, JSON.stringify(result, null, 2), "utf8");
  await rename(tempPath, job.resultPath);
}

async function main() {
  const repoDir = underWorkspace(job.repository.target_dir);
  const stateDir = underWorkspace(path.dirname(job.resultPath));
  const opencodeConfigPath = path.join(stateDir, "opencode.json");
  const opencodeConfigDir = underWorkspace(
    process.env.OPENCODE_CONFIG_DIR || "/workspace/.symphony/opencode-config",
  );
  await mkdir(stateDir, { recursive: true });
  await mkdir(opencodeConfigDir, { recursive: true });
  await writeFile(job.eventsPath, "", "utf8");

  let created = false;
  if (!(await exists(path.join(repoDir, ".git")))) {
    if (repoDir !== "/workspace") await rm(repoDir, { recursive: true, force: true });
    await mkdir(path.dirname(repoDir), { recursive: true });
    const clone = await run(
      "git",
      ["clone", "--depth", "1", "--branch", job.repository.default_branch, job.repository.clone_url, repoDir],
      { cwd: "/workspace" },
    );
    if (clone.code !== 0) throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
    created = true;
  }

  if (created) await runHook("after_create", job.hooks.after_create, repoDir);
  await runHook("before_run", job.hooks.before_run, repoDir);

  const model = normalizeOpenCodeModel(job.model, job.agentProvider?.id ?? "cloudflare-workers-ai");
  await writeOpenCodeConfig(opencodeConfigPath, job.agentProvider, model);

  const args = [
    "run",
    "--format",
    "json",
    "--pure",
    "--dangerously-skip-permissions",
    "--dir",
    repoDir,
    "--title",
    job.issue.identifier,
  ];
  if (threadId) args.push("--session", threadId);
  if (model) args.push("--model", model);
  if (job.reasoningEffort) {
    args.push("--variant", job.reasoningEffort);
  }
  args.push(job.prompt);

  const agentEnv = {
    OPENCODE_CONFIG_DIR: opencodeConfigDir,
    OPENCODE_CONFIG: opencodeConfigPath,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
  };
  if (process.env.GITHUB_TOKEN) {
    agentEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    agentEnv.GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SANDBOX_ENV_") || !value) continue;
    const forwardedKey = key.slice("SANDBOX_ENV_".length);
    if (forwardedKey) agentEnv[forwardedKey] = value;
  }

  const opencode = await run("opencode", args, {
    cwd: repoDir,
    env: agentEnv,
    onStdout: queueAgentEvents,
  });
  await eventWriteChain;
  if (eventBuffer.trim()) consumeEventLine(eventBuffer);

  if (opencode.code !== 0) {
    throw new Error(`opencode exited with ${opencode.code}: ${opencode.stderr || opencode.stdout}`);
  }

  await runHook("after_run", job.hooks.after_run, repoDir);
  await atomicResult({
    ok: true,
    runId: job.runId,
    threadId,
    finalResponse: finalResponse || opencode.stdout,
    usage,
    completedAt: new Date().toISOString(),
  });
}

try {
  await main();
} catch (error) {
  try {
    await atomicResult({
      ok: false,
      runId: job.runId,
      threadId,
      error: error instanceof Error ? error.stack || error.message : String(error),
      stderrTail: stderrCapture.slice(-8_000),
      completedAt: new Date().toISOString(),
    });
  } catch (writeError) {
    console.error("Failed to write runner result", writeError);
  }
  console.error(error);
  process.exitCode = 1;
}
