import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedRi00 } from './ri00/seed.mjs';
import { resolveDestination } from './ri00/identity.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const home = resolveDestination(option('--home', fs.mkdtempSync(path.join(os.tmpdir(), 'peer-ri00-synthetic-'))));
const personal = path.join(os.homedir(), '.peer-agent');
if (home === personal || home.startsWith(personal + path.sep)) throw new Error('personal_fixture_forbidden');
const moduleRoot = path.resolve(option('--module-root', fileURLToPath(new URL('../../..', import.meta.url))));
const receipt = await seedRi00({ moduleRoot, home, plans: Number(option('--plans', '1460')), sessions: Number(option('--sessions', '23')),
  ready: Number(option('--ready', '6')), evidence: Number(option('--evidence', '69045')) });
console.log(JSON.stringify({ home, ...receipt }));
