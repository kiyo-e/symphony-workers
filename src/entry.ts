import workflowText from "../WORKFLOW.md";
import { createWorker } from "./index";

export { ContainerProxy, ProjectOrchestrator, Sandbox } from "./index";

export default createWorker({ workflowText });
