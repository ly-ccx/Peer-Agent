import { homedir } from 'node:os';
import { join } from 'node:path';

/** Same root the conversation store uses: PEER_AGENT_HOME, then PEER_USER_DATA_PATH. */
export function resolvePeerDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PEER_AGENT_HOME?.trim() || env.PEER_USER_DATA_PATH?.trim();
  return override || join(homedir(), '.peer-agent');
}
