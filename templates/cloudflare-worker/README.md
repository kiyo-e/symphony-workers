# Symphony Workers App

This is the thin deployment template for `symphony-workers`.

Edit these files for your environment:

- `WORKFLOW.md`
- `wrangler.jsonc`
- `Dockerfile`
- `.dev.vars` for local development only

Run setup after copying the template:

```bash
bun install
bun run cf-typegen
bun run typecheck
```

When this template is created with `npx symphony-workers create <directory>`, `wrangler.jsonc` uses that directory name as the Cloudflare Worker name.

The included `Dockerfile` uses the published base image. That base image tag must exist before this template can be deployed from a fresh project.

```Dockerfile
FROM ghcr.io/kiyo-e/symphony-workers-base:0.2.4
```

`wrangler.jsonc` points at `./Dockerfile`, so the container deployed to Cloudflare is built from this file. Add project-specific packages or binaries here instead of forking `symphony-workers`.

Sandbox internet egress is open by default. To enforce a deny-by-default policy for one deployment, define a local `Sandbox` class in `src/index.ts` and set `allowedHosts` or `deniedHosts` there.

```ts
import workflowText from "../WORKFLOW.md";
import {
  ContainerProxy,
  ProjectOrchestrator,
  Sandbox as SymphonySandbox,
  createWorker,
} from "symphony-workers";

export { ContainerProxy, ProjectOrchestrator };

export class Sandbox extends SymphonySandbox {
  allowedHosts = [
    "api.cloudflare.com",
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
  ];
}

export default createWorker({ workflowText });
```

When `allowedHosts` is set, every external host needed by hooks or agent commands must be listed here.
