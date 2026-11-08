import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-rehearsal-'));
process.env.PEER_AGENT_HOME = root;
const { rehearseLegacyObligationsOnDesktop } = await import('../apps/desktop/electron/main/project-agent/obligation-desktop-rehearsal.mjs');
const report = await rehearseLegacyObligationsOnDesktop({ rootDir: root });
console.log(JSON.stringify({ ...report, home: root, bridge: 'liveDelegationSupervisor+local-tool-host' }, null, 2));
if (!report.ok) process.exitCode = 1;
