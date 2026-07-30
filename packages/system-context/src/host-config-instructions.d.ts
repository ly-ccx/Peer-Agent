export interface ConfigInstructionContextItem {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly priority: number;
  readonly source: string;
}

export interface HostPromptSettings {
  readonly systemInstructions?: unknown;
  readonly replyLanguage?: unknown;
  readonly gitBranchPrefix?: unknown;
}

export const DEFAULT_GIT_BRANCH_PREFIX: 'PeerAgent/';
export const REPLY_LANGUAGE_OPTIONS: readonly string[];
export function resolveGitBranchPrefix(value: unknown): string;
export function buildConfigInstructionContext(
  systemInstructions: unknown,
): readonly ConfigInstructionContextItem[];
export function buildReplyLanguageContext(
  replyLanguage: unknown,
): readonly ConfigInstructionContextItem[];
export function buildGitBranchPrefixContext(
  gitBranchPrefix: unknown,
): readonly ConfigInstructionContextItem[];
export function buildHostConfigInstructions(
  settings?: HostPromptSettings,
): readonly ConfigInstructionContextItem[];
