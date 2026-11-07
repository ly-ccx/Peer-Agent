import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rehearseLegacyObligations } from '../packages/runtime-node/src/project-agent/obligation-legacy-rehearsal.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-rehearsal-'));
process.env.PEER_AGENT_HOME = root;
const report = await rehearseLegacyObligations({ rootDir: root });
console.log(JSON.stringify({ ...report, home: root }, null, 2));
if (!report.ok) process.exitCode = 1;
