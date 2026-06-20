import type { ProjectOrchestrator } from "../src/orchestrator";
import type { Sandbox } from "../src/worker";

declare global {
  interface CloudflareBindings {
    BACKUP_BUCKET: R2Bucket;
    PROJECT_KEY: string;
    BACKUP_BUCKET_NAME: string;
    Sandbox: DurableObjectNamespace<Sandbox>;
    ORCHESTRATOR: DurableObjectNamespace<ProjectOrchestrator>;
  }
}

export {};
