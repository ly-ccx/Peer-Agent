import { CLI_EXIT } from './cli-exit.ts';
import { resolvePeerDataHome } from './cli-data-home.ts';
import { formatModelLines, selectableModelRows } from './cli-model-lines.ts';
import { resolveTuiModelConfig } from './model-config.ts';

export { formatModelLines, selectableModelRows } from './cli-model-lines.ts';

export async function runPeerModels(hooks: {
  readonly env?: NodeJS.ProcessEnv;
  readonly loadConfig?: () => { readonly catalog: Parameters<typeof selectableModelRows>[0] };
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
} = {}): Promise<number> {
  const writeOut = hooks.stdout ?? ((line: string) => console.log(line));
  const writeErr = hooks.stderr ?? ((line: string) => console.error(line));
  try {
    const env = hooks.env ?? process.env;
    const config = hooks.loadConfig?.() ?? resolveTuiModelConfig(env, {
      userDataPath: resolvePeerDataHome(env),
    });
    const models = selectableModelRows(config.catalog);
    if (models.length === 0) {
      writeErr('No model configured.');
      return CLI_EXIT.ok;
    }
    writeOut(formatModelLines(models));
    return CLI_EXIT.ok;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeErr(`peer models: ${message}`);
    return CLI_EXIT.runtime;
  }
}
