import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAICompatibleProvider, loadSharedModelMetadataList, loadSharedModelSelection,
  resolveOpenCodeGoBaseUrl, sendAnthropicMessagesStream, type SharedModelMetadata, type ModelProvider } from '@peer-agent/runtime-node/models';
import { redactShellOutput } from '@peer-agent/runtime-node/project-agent';
import { createTuiSharedModelCredentialStore } from '../model-credential-store.ts';
import { createAnthropicMessagesProvider } from '../anthropic-messages-provider.ts';
import { createTuiProviderFetch } from '../provider-transport.ts';
import { resolveTuiWire } from '../provider-wire-matrix.ts';
import { INTERACTIVE_LIVE_BUDGET, INTERACTIVE_LIVE_SCENARIOS, runInteractiveLiveCase, type InteractiveLiveScenario } from './interactive-live-validation.ts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export const INTERACTIVE_LIVE_HELP = `Opt-in interactive-result validation; uses configured API keys and synthetic data only.
Usage: pnpm --filter @peer-agent/tui qa:interactive:live --list [--user-data DIRECTORY]
       pnpm --filter @peer-agent/tui qa:interactive:live --run --model ENTRY_ID [--model ENTRY_ID]
         [--scenario publish|repair|denied|verify] [--output EXISTING_DIRECTORY] [--user-data DIRECTORY]
--list and --help make no model requests and do not read credentials.
--run requires explicit configured model entry IDs. Defaults: publish, repair and denied; verify is explicit.
Only OpenAI Chat / Anthropic Messages API-key wires are included in this validation command.
Per model/scenario: at most 4 model requests, 1800 output tokens/request, 45s/request, 150s/case,
4 worker tool calls. Verify permits 4 additional Verifier requests and up to 8 readonly calls within the same case deadline.
Native permission requests are denied. User configuration and the daily app are left alone.
Repair supplies an actual failed Tool Result as explicit user factual context from a test-driver seed.
It does not fabricate assistant/thinking history or count the seed as a natural model failure.
Runtime token usage is recorded. Verify records the separate semantic review; billing receipts and task acceptance remain separate.
Set PEER_CREDENTIAL_HELPER_PATH if the repository helper has not been built here.\n`;

export function parseInteractiveLiveArgs(args: readonly string[]) {
  const options = { run: false, list: false, help: false, models: [] as string[], scenarios: [] as InteractiveLiveScenario[],
    userData: path.join(os.homedir(), '.peer-agent'), output: os.tmpdir() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--run') options.run = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--model', '--scenario', '--user-data', '--output'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('live_option_value_missing');
      if (arg === '--model') options.models.push(value);
      else if (arg === '--scenario') {
        if (!INTERACTIVE_LIVE_SCENARIOS.includes(value as InteractiveLiveScenario)) throw new Error('live_scenario_invalid');
        options.scenarios.push(value as InteractiveLiveScenario);
      } else if (arg === '--user-data') options.userData = path.resolve(value);
      else options.output = path.resolve(value);
    } else throw new Error('live_option_unknown');
  }
  if (!options.help && (options.run === options.list || (options.run && !options.models.length))) throw new Error('live_explicit_selection_required');
  options.models = [...new Set(options.models)];
  options.scenarios = options.scenarios.length ? [...new Set(options.scenarios)] : ['publish', 'repair', 'denied'];
  if (options.models.length > 4) throw new Error('live_model_limit');
  return options;
}

function supportedWire(metadata: SharedModelMetadata) {
  const decision = resolveTuiWire(metadata);
  return metadata.authMethod === 'api_key' && decision.kind === 'supported'
    && (decision.wire === 'openai-chat' || decision.wire === 'anthropic-messages') ? decision.wire : undefined;
}

export function sanitizeInteractiveLiveDiagnostic(value: unknown, secrets: readonly string[] = []): string {
  const detail = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? '');
  const replaced = secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[credential]'), detail);
  return redactShellOutput(replaced).replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 1000);
}

function isInside(parent: string, target: string) {
  const relative = path.relative(parent, target);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function interactiveLiveOutputBase(base: string, userData: string, repository: string): string {
  const canonical = realpathSync(base);
  if ([realpathSync(userData), realpathSync(repository)].some(root => isInside(root, canonical))) throw new Error('live_output_must_be_external');
  return canonical;
}

/** No network, credentials or writes occur until --run and exact model selection are validated. */
export async function runInteractiveLiveCommand(args: readonly string[], log: (line: string) => void = console.log): Promise<boolean> {
  const options = parseInteractiveLiveArgs(args);
  if (options.help) { log(INTERACTIVE_LIVE_HELP); return true; }
  const configured = loadSharedModelMetadataList({ userDataPath: options.userData });
  if (options.list) {
    log(JSON.stringify(configured.map(metadata => ({ entryId: metadata.entryId, provider: metadata.providerId, model: metadata.model,
      wire: supportedWire(metadata) ?? 'outside_this_validation', credentialStored: metadata.credentialStored })), null, 2));
    return true;
  }
  const selected = options.models.map(id => {
    const matches = configured.filter(metadata => metadata.entryId === id);
    if (matches.length !== 1 || !supportedWire(matches[0]) || !matches[0].credentialStored) throw new Error('live_selected_model_unavailable');
    return matches[0];
  });
  const output = mkdtempSync(path.join(interactiveLiveOutputBase(options.output, options.userData, repositoryRoot), 'peer-interactive-live-'));
  const source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()) };
  const summary = { schemaVersion: 1, source, startedAt: new Date().toISOString(), finishedAt: '', realModel: true,
    syntheticInput: true, installedBuild: false, independentReview: false, budget: INTERACTIVE_LIVE_BUDGET,
    scope: 'Actual TUI turn, tool, permission and encoder ports; isolated Bot/Plan and checked headless runtime fixture. Not full goal acceptance.',
    samples: [] as Array<{ entryId?: string; provider: string; model: string; scenario: InteractiveLiveScenario; report: string; ok: boolean; httpRequests: number; error?: string }>, ok: false };
  const persist = () => writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  persist(); log(JSON.stringify({ output, source, cases: selected.length * options.scenarios.length }));
  const credentials = createTuiSharedModelCredentialStore({ dataHome: options.userData });
  for (const [modelIndex, metadata] of selected.entries()) {
    for (const scenario of options.scenarios) {
      const directory = path.join(output, `${modelIndex + 1}-${scenario}`);
      const sample = { entryId: metadata.entryId, provider: metadata.providerId, model: metadata.model, scenario,
        report: path.join(directory, 'report.json'), ok: false, httpRequests: 0, error: undefined as string | undefined };
      summary.samples.push(sample); persist();
      let secret = '';
      try {
        const selection = loadSharedModelSelection({ userDataPath: options.userData, credentialId: metadata.credentialId,
          credentialStore: { getApiKey: id => credentials.getApiKey(id), getOAuthTokens: () => null,
            setOAuthTokens() { throw new Error('live_credential_write_forbidden'); } } });
        if (!selection?.apiKey) throw new Error('live_credential_unavailable');
        secret = selection.apiKey;
        // Disable transport recovery here so the physical HTTP budget is independently bounded.
        const transport = createTuiProviderFetch({ connectionRecovery: false });
        const countedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (++sample.httpRequests > 8) throw new Error('live_http_limit');
          return transport(input, init);
        }) as typeof fetch;
        const wire = supportedWire(metadata)!;
        const baseUrl = metadata.channelId?.startsWith('opencode-go') ? resolveOpenCodeGoBaseUrl(wire, metadata.baseUrl) : metadata.baseUrl;
        const extraHeaders = metadata.channelId?.startsWith('opencode-go') ? { 'x-opencode-session': `peer-interactive-validation-${modelIndex}-${scenario}` } : undefined;
        const provider: ModelProvider = wire === 'openai-chat'
          ? createOpenAICompatibleProvider({ config: { providerId: metadata.credentialId, apiKey: secret, baseUrl, headers: extraHeaders }, fetch: countedFetch })
          : createAnthropicMessagesProvider({ providerId: metadata.credentialId, baseUrl, extraHeaders, getApiKey: async () => secret,
            sendStream: streamArgs => sendAnthropicMessagesStream({ ...streamArgs, fetchImpl: countedFetch }) });
        const report = await runInteractiveLiveCase({ directory, scenario, model: metadata, realModel: true, provider,
          sanitize: value => sanitizeInteractiveLiveDiagnostic(value, [secret]),
          onProgress(report) { log(JSON.stringify({ provider: metadata.providerId, model: metadata.model, scenario,
            requests: report.requests.length, approvals: report.approvals, finished: Boolean(report.finishedAt) })); } });
        sample.ok = report.ok;
      } catch (error) { sample.error = sanitizeInteractiveLiveDiagnostic(error, [secret]); }
      finally { secret = ''; persist(); }
    }
  }
  summary.finishedAt = new Date().toISOString(); summary.ok = summary.samples.every(sample => sample.ok); persist();
  log(JSON.stringify({ output, ok: summary.ok })); return summary.ok;
}
