import {
  createProjectGoalRunnerHost
} from "@peer-agent/runtime-node/project-agent";
import { createBroadcastSink } from './turn-sinks.mjs';
export {
  buildGoalRunnerMessage
} from "@peer-agent/runtime-node/project-agent";
export function createDesktopGoalRunnerHost(options = {}) {
  return createProjectGoalRunnerHost({ ...options, createSink: () => createBroadcastSink({ getWindows: options.getMainWindows }) });
}
