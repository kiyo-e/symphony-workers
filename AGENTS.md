# Repository Guidelines

## Project Structure & Module Organization

This repository publishes `symphony-workers`, a Bun/TypeScript runtime for Cloudflare Workers, Durable Objects, and Cloudflare Sandboxes. Runtime source lives in `src/`; `src/entry.ts` is the local Worker entrypoint, `src/worker.ts` defines the Hono app and exported Worker factory, and orchestration logic is split across `src/orchestrator.ts`, `src/workflow.ts`, and `src/github.ts`.

`templates/cloudflare-worker/` is the copyable user app template. Keep template changes aligned with the package contract when bindings, migrations, Docker image usage, or `WORKFLOW.md` expectations change. The root `Dockerfile` builds the published base image, while `wrangler.jsonc` describes this repository's development Worker configuration.

## Build, Test, and Development Commands

- `bun install` installs dependencies using the pinned Bun package manager.
- `bun run workflow:init` creates local `WORKFLOW.md` from `WORKFLOW.md.example`.
- `bun run cf-typegen` regenerates `worker-configuration.d.ts` from Wrangler bindings.
- `bun run typecheck` runs strict TypeScript checks without emitting files.
- `bun run build` emits the package build through `tsconfig.build.json`.
- `bun run dev` starts `wrangler dev`; `bun run deploy` deploys with minification.

## Coding Style & Naming Conventions

Write TypeScript as ESM with explicit imports and exported interfaces where they form the public package contract. Match the existing style: 2-space indentation, semicolons, `camelCase` functions and variables, `PascalCase` classes/types, and uppercase environment binding names such as `BACKUP_BUCKET_NAME`. Keep code paths simple; avoid compatibility shims or speculative configuration unless the existing Cloudflare API requires them.

## Testing Guidelines

There is no dedicated test runner configured yet. For every code change, run `bun run typecheck` and `bun run build`; run `bun run cf-typegen` first when `wrangler.jsonc` or bindings change. If adding tests, place them near the code they cover or under a clearly named test directory, and use names that describe behavior, for example `workflow-parsing.test.ts`.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, for example `Avoid polling idle issue context` and `Add create template and base image publishing`. Keep commits focused and avoid mixing docs, runtime behavior, and template changes unless the contract requires all three.

No PR template is currently present under `.github/`. PR descriptions should state the user-facing change, list verification commands run, and call out any Cloudflare binding, Durable Object migration, Docker image, or template contract impact.

## Security & Configuration Tips

Do not commit `.dev.vars`, local `WORKFLOW.md`, secrets, or generated Wrangler state. Keep `WORKFLOW.md.example`, `README.md`, `README.ja.md`, `src/env.d.ts`, `worker-configuration.d.ts`, and template files consistent when changing required configuration.
