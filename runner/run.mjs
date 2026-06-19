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
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      finalResponse = event.item.text ?? finalResponse;
    }
    if (event.type === "turn.completed") usage = event.usage;
  } catch {
    // The complete raw stream remains available for diagnostics.
  }
}

async function appendCodexEvents(chunk) {
  await appendFile(job.eventsPath, chunk, "utf8");
  eventBuffer += chunk;
  const lines = eventBuffer.split("\n");
  eventBuffer = lines.pop() ?? "";
  for (const line of lines) consumeEventLine(line);
}

function queueCodexEvents(chunk) {
  eventWriteChain = eventWriteChain.then(() => appendCodexEvents(chunk));
  eventWriteChain.catch((error) => console.error("Codex event write failed", error));
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function addCodexConfig(args, key, value) {
  args.push("-c", `${key}=${tomlString(value)}`);
}

async function atomicResult(result) {
  const tempPath = `${job.resultPath}.tmp`;
  await writeFile(tempPath, JSON.stringify(result, null, 2), "utf8");
  await rename(tempPath, job.resultPath);
}

async function main() {
  const repoDir = underWorkspace(job.repository.target_dir);
  const stateDir = underWorkspace(path.dirname(job.resultPath));
  const codexHome = underWorkspace(process.env.CODEX_HOME || "/workspace/.symphony/codex-home");
  process.env.CODEX_HOME = codexHome;
  await mkdir(stateDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
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

  const args = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (job.codexProvider) {
    const providerKey = `model_providers.${job.codexProvider.id}`;
    addCodexConfig(args, "model_provider", job.codexProvider.id);
    addCodexConfig(args, `${providerKey}.name`, job.codexProvider.name);
    addCodexConfig(args, `${providerKey}.base_url`, job.codexProvider.baseUrl);
    addCodexConfig(args, `${providerKey}.env_key`, job.codexProvider.envKey);
    addCodexConfig(args, `${providerKey}.wire_api`, job.codexProvider.wireApi);
  }
  if (job.model) args.push("--model", job.model);
  if (job.reasoningEffort) {
    addCodexConfig(args, "model_reasoning_effort", job.reasoningEffort);
  }
  if (job.threadId) args.push("resume", job.threadId, "-");
  else args.push("-");

  const codex = await run("codex", args, {
    cwd: repoDir,
    stdinText: job.prompt,
    onStdout: queueCodexEvents,
  });
  await eventWriteChain;
  if (eventBuffer.trim()) consumeEventLine(eventBuffer);

  if (codex.code !== 0) {
    throw new Error(`codex exited with ${codex.code}: ${codex.stderr || codex.stdout}`);
  }

  await runHook("after_run", job.hooks.after_run, repoDir);
  await atomicResult({
    ok: true,
    runId: job.runId,
    threadId,
    finalResponse,
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
