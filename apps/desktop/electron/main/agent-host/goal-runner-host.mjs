import {
  createProjectGoalRunnerHost
} from "@peer-agent/runtime-node/project-agent";
import { createBroadcastSink } from './turn-sinks.mjs';
import { desktopInteractiveRuntime } from '../interactive-results/runtime-port.mjs';
export {
  buildGoalRunnerMessage
} from "@peer-agent/runtime-node/project-agent";
export function createDesktopGoalRunnerHost(options = {}) {
  return createProjectGoalRunnerHost({ getInteractiveVerification: () => desktopInteractiveRuntime()?.verification ?? null,
    ...options, createSink: () => createBroadcastSink({ getWindows: options.getMainWindows }) });
}
