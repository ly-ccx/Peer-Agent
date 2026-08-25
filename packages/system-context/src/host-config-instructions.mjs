export const DEFAULT_GIT_BRANCH_PREFIX = 'PeerAgent/';

const REPLY_LANGUAGE_NAMES = Object.freeze({
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  'en-US': 'English',
  'ja-JP': 'Japanese (日本語)',
  'ko-KR': 'Korean (한국어)',
  'fr-FR': 'French (Français)',
  'de-DE': 'German (Deutsch)',
  'es-ES': 'Spanish (Español)',
  'ru-RU': 'Russian (Русский)',
});

export const REPLY_LANGUAGE_OPTIONS = Object.freeze(Object.keys(REPLY_LANGUAGE_NAMES));

export function resolveGitBranchPrefix(value) {
  if (typeof value !== 'string') return DEFAULT_GIT_BRANCH_PREFIX;
  const trimmed = value.trim();
  return trimmed || DEFAULT_GIT_BRANCH_PREFIX;
}

export function buildConfigInstructionContext(systemInstructions) {
  const content = typeof systemInstructions === 'string' ? systemInstructions.trim() : '';
  if (!content) return [];
  return [{
    id: 'settings.systemInstructions',
    title: 'System Instructions',
    content,
    priority: 0,
    source: 'settings.systemInstructions',
  }];
}

export function buildReplyLanguageContext(replyLanguage) {
  const code = typeof replyLanguage === 'string' ? replyLanguage.trim() : '';
  if (!code || code === 'auto') return [];
  const languageName = REPLY_LANGUAGE_NAMES[code];
  if (!languageName) return [];
  return [{
    id: 'settings.replyLanguage',
    title: 'Reply Language',
    content: `Always write your replies to the user in ${languageName}, regardless of the language the user writes in. Keep code, file paths, identifiers, and quoted content unchanged.`,
    priority: 0,
    source: 'settings.replyLanguage',
  }];
}

export function buildGitBranchPrefixContext(gitBranchPrefix) {
  const prefix = resolveGitBranchPrefix(gitBranchPrefix);
  return [{
    id: 'settings.gitBranchPrefix',
    title: 'Git Branch Prefix',
    content: `When you create a new git branch (e.g. via \`git checkout -b\` or \`git switch -c\`), always name it with the prefix "${prefix}". Use only ASCII letters, digits, and hyphens for the rest of the name (for example "${prefix}my-feature"). Never use Chinese or other non-ASCII characters in new branch names. Do not apply this prefix to existing branches you only check out.`,
    priority: 0,
    source: 'settings.gitBranchPrefix',
  }];
}

export function buildHostConfigInstructions(settings = {}) {
  return [
    ...buildConfigInstructionContext(settings.systemInstructions),
    ...buildReplyLanguageContext(settings.replyLanguage),
    ...buildGitBranchPrefixContext(settings.gitBranchPrefix),
  ];
}
