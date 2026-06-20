import workflowText from "../WORKFLOW.md";
import { createWorker } from "symphony-workers";

export { ContainerProxy, ProjectOrchestrator, Sandbox } from "symphony-workers";

export default createWorker({ workflowText });

