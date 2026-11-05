import { runInteractiveLiveCommand, sanitizeInteractiveLiveDiagnostic } from '../src/project-agent/interactive-live-command.ts';

try {
  if (!await runInteractiveLiveCommand(process.argv.slice(2))) process.exitCode = 1;
} catch (error) {
  console.error(sanitizeInteractiveLiveDiagnostic(error));
  process.exitCode = 1;
}
