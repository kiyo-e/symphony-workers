#!/usr/bin/env node

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , commandOrTarget, maybeTarget] = process.argv;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(packageRoot, "templates/cloudflare-worker");
const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);

function usage() {
  console.log(`Usage:
  npx symphony-workers create <directory>
  npx symphony-workers <directory>`);
}

function targetFromArgs() {
  if (commandOrTarget === "--help" || commandOrTarget === "-h") {
    usage();
    process.exit(0);
  }
  if (!commandOrTarget) return undefined;
  if (commandOrTarget === "--version" || commandOrTarget === "-v") {
    console.log(packageJson.version);
    process.exit(0);
  }
  if (commandOrTarget === "create") return maybeTarget;
  return commandOrTarget;
}

async function ensureWritableTarget(target) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(target);
  if (entries.length > 0) {
    throw new Error(`Target directory is not empty: ${target}`);
  }
}

async function finalizeTemplate(target) {
  const gitignorePath = path.join(target, "gitignore");
  try {
    await writeFile(path.join(target, ".gitignore"), await readFile(gitignorePath, "utf8"));
    await rm(gitignorePath);
  } catch {
    // npm excludes template .gitignore files, so published packages use gitignore as a fallback.
  }

  const appPackagePath = path.join(target, "package.json");
  const appPackage = JSON.parse(await readFile(appPackagePath, "utf8"));
  appPackage.dependencies["symphony-workers"] = packageJson.version;
  await writeFile(appPackagePath, `${JSON.stringify(appPackage, null, 2)}\n`);
}

async function main() {
  const targetArg = targetFromArgs();
  if (!targetArg) {
    usage();
    process.exitCode = 1;
    return;
  }

  const target = path.resolve(process.cwd(), targetArg);
  await ensureWritableTarget(target);
  await cp(templateDir, target, { recursive: true });
  await finalizeTemplate(target);

  console.log(`Created ${path.relative(process.cwd(), target) || "."}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  cd ${path.relative(process.cwd(), target) || "."}`);
  console.log("  bun install");
  console.log("  bun run cf-typegen");
  console.log("  bun run typecheck");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
