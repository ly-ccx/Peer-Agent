import os from 'node:os';
import path from 'node:path';
import { parseInteractiveArtifactRef } from '@peer-agent/protocol';
import { readLocalInteractiveText } from '@peer-agent/runtime-node/interactive-results';
import { CLI_EXIT } from './cli-exit.ts';

function terminalText(value: string): string {
  // Preserve line breaks and tabs while removing terminal controls and bidi overrides.
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function runPeerResult(options: { reference: string; json: boolean }): number {
  const reference = parseInteractiveArtifactRef(options.reference);
  if (!reference) {
    console.error('peer result: invalid fixed result reference');
    return CLI_EXIT.usage;
  }
  const dataHome = process.env.PEER_AGENT_HOME ?? process.env.PEER_USER_DATA_PATH ?? path.join(os.homedir(), '.peer-agent');
  try {
    const result = readLocalInteractiveText(dataHome, reference);
    const title = terminalText(result.title), textFallback = terminalText(result.textFallback);
    if (options.json) console.log(JSON.stringify({ ...result, title, textFallback }));
    else console.log([
      title,
      result.ref,
      `Availability: ${result.availability}`,
      `Source: ${result.source.conversationId} / ${result.source.toolCallId}`,
      `Saved model summary, unverified${result.truncated ? ' (truncated)' : ''}`,
      textFallback,
    ].join('\n'));
    return CLI_EXIT.ok;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    console.error(`peer result: ${typeof code === 'string' && /^(?:interactive_[a-z_]+|publication_index_pending)$/.test(code) ? code : 'interactive_result_unavailable'}`);
    return code === 'interactive_scope_denied' ? CLI_EXIT.auth : CLI_EXIT.runtime;
  }
}
