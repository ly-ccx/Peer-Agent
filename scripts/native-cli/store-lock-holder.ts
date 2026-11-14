// Real legacy lock implementation, isolated fixture only; not a runtime adapter.
import { writeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from '../../packages/conversation-store/src/conversation-file-lock.mjs';
const root = process.env.PEER_NATIVE_CONFORMANCE_ROOT;
if (!root || !existsSync(join(root, '.native-cli-fixture'))) throw Error('Explicit fixture root required');
withFileLock(join(root, 'conversations/index.jsonl'), () => {
  writeSync(1, `${JSON.stringify({ phase: 'locked' })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
});
writeSync(1, `${JSON.stringify({ ok: true })}\n`);
