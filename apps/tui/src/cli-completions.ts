import { CLI_EXIT } from './cli-exit.ts';

export type CompletionShell = 'bash' | 'zsh' | 'fish';

const COMMANDS = [
  ['acp', 'Run the ACP agent on stdio'],
  ['bots', 'Browse bots'],
  ['completions', 'Print a shell completion script'],
  ['doctor', 'Check the local peer install'],
  ['exec', 'Run one task without the TUI'],
  ['export', 'Export a stored session as Markdown'],
  ['help', 'Show help'],
  ['models', 'List configured models'],
  ['result', 'Read an interactive result'],
  ['sessions', 'List, resume, or delete sessions'],
  ['update', 'Install the newest release on this channel'],
  ['version', 'Print the version'],
] as const;

export function completionScript(shell: CompletionShell): string {
  const names = COMMANDS.map(([name]) => name).join(' ');
  if (shell === 'fish') {
    return [
      ...COMMANDS.map(([name, description]) => `complete -c peer -n __fish_use_subcommand -a ${name} -d '${description}'`),
      'complete -c peer -n __fish_use_subcommand -l classic -d \'Open task mode\'',
      'complete -c peer -n __fish_use_subcommand -l help -d \'Show help\'',
      'complete -c peer -n __fish_use_subcommand -l version -d \'Print version\'',
      'complete -c peer -n "__fish_seen_subcommand_from sessions" -a "list resume delete" -d \'Session action\'',
      'complete -c peer -n "__fish_seen_subcommand_from completions" -a "bash zsh fish"',
      'complete -c peer -n "__fish_seen_subcommand_from update" -l check -d \'Report without installing\'',
      'complete -c peer -n "__fish_seen_subcommand_from export" -l output -d \'Write to a file\'',
      'complete -c peer -n "__fish_seen_subcommand_from export" -l force -d \'Overwrite the output file\'',
      '',
    ].join('\n');
  }
  if (shell === 'zsh') {
    const entries = COMMANDS.map(([name, description]) => `    '${name}:${description}'`).join('\n');
    return [
      '#compdef peer',
      '_peer() {',
      '  local -a commands',
      '  commands=(',
      entries,
      '  )',
      '  if (( CURRENT == 2 )); then',
      '    _describe command commands',
      '    _arguments \'--classic[Open task mode]\' \'--help[Show help]\' \'--version[Print version]\'',
      '    return',
      '  fi',
      '  case "$words[2]" in',
      '    sessions) _values action list resume delete ;;',
      '    completions) _values shell bash zsh fish ;;',
      '    update) _arguments \'--check[Report without installing]\' \'--help[Show help]\' ;;',
      '    export) _arguments \'--output[Write to a file]:file:_files\' \'--force[Overwrite]\' ;;',
      '  esac',
      '}',
      'if (( ${+functions[compdef]} )); then compdef _peer peer; fi',
      '',
    ].join('\n');
  }
  return [
    '_peer() {',
    '  local cur',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  local commands="${names} --classic --help --version"`,
    '  if [[ ${COMP_CWORD} -eq 1 ]]; then',
    '    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )',
    '    return',
    '  fi',
    '  case "${COMP_WORDS[1]}" in',
    '    sessions) COMPREPLY=( $(compgen -W "list resume delete --help" -- "$cur") ) ;;',
    '    completions) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ) ;;',
    '    update) COMPREPLY=( $(compgen -W "--check --help" -- "$cur") ) ;;',
    '    export) COMPREPLY=( $(compgen -W "--output --force --help" -- "$cur") ) ;;',
    '  esac',
    '}',
    'complete -F _peer peer',
    '',
  ].join('\n');
}

export function runPeerCompletions(
  shell: CompletionShell,
  hooks: { readonly stdout?: (line: string) => void } = {},
): number {
  const writeOut = hooks.stdout ?? ((line: string) => console.log(line));
  writeOut(completionScript(shell).replace(/\n$/, ''));
  return CLI_EXIT.ok;
}
