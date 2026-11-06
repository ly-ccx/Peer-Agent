// Explicit offline storage maintenance; never boots the app, acquires a host or executes tasks.
import { inspectCoordinationFork, recoverCoordinationForkBackup } from '../packages/runtime-node/src/project-agent/coordination-fork-recovery.mjs';
const [action, directory, sourceFingerprint, reviewedPrefixSha256] = process.argv.slice(2);
try {
  if (!directory || !['--inspect', '--recover'].includes(action)) throw new Error('Usage: node scripts/repair-coordination-fork.mjs --inspect <offline-backup> | --recover <offline-backup> <source-fingerprint> <reviewed-prefix-sha256>');
  if (action === '--inspect') {
    const { state, conflicts, sources, ...summary } = inspectCoordinationFork(directory);
    console.log(JSON.stringify({ ...summary, sourceFiles: Object.keys(sources).length,
      conflicts: conflicts.map(({ bucket, id }) => ({ bucket, id })) }, null, 2));
  } else {
    console.log(JSON.stringify(recoverCoordinationForkBackup({ directory, sourceFingerprint, reviewedPrefixSha256 }), null, 2));
  }
} catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
