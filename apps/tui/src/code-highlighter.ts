/**
 * Lightweight fenced-code syntax highlighter for the TUI.
 * Zero dependency: tokenizes comments / strings / numbers / keywords / types
 * for common languages. Unknown languages fall back to plain text tokens.
 */

export type SyntaxTokenKind =
  | 'plain'
  | 'keyword'
  | 'type'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'property'
  | 'operator'
  | 'punctuation'
  | 'literal';

export type SyntaxToken = {
  kind: SyntaxTokenKind;
  text: string;
};

type LanguageFamily =
  | 'clike'
  | 'python'
  | 'ruby'
  | 'shell'
  | 'sql'
  | 'json'
  | 'yaml'
  | 'html'
  | 'css'
  | 'go'
  | 'rust'
  | 'plain';

type LanguageProfile = {
  family: LanguageFamily;
  keywords: ReadonlySet<string>;
  types: ReadonlySet<string>;
  literals: ReadonlySet<string>;
  lineComment?: string;
  blockComment?: readonly [string, string];
  /** Prefer ''' / """ style strings (python). */
  tripleQuotes?: boolean;
  /** Shell-style `#` comments and `$` vars get a light touch via keywords. */
  hashComment?: boolean;
  /** YAML / shell allow `#` comments only when not in string. */
};

const C_KEYWORDS = [
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'goto', 'sizeof', 'typedef', 'struct', 'union', 'enum', 'const', 'static',
  'extern', 'volatile', 'register', 'inline', 'restrict',
];

const JS_KEYWORDS = [
  ...C_KEYWORDS,
  'function', 'var', 'let', 'const', 'class', 'extends', 'super', 'new', 'this',
  'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw',
  'async', 'await', 'yield', 'import', 'export', 'from', 'as', 'default',
  'with', 'debugger', 'delete', 'void', 'get', 'set', 'static', 'public',
  'private', 'protected', 'readonly', 'abstract', 'implements', 'interface',
  'package', 'namespace', 'module', 'declare', 'type', 'keyof', 'infer',
  'is', 'asserts', 'satisfies', 'override', 'accessor', 'using',
];

const JS_TYPES = [
  'string', 'number', 'boolean', 'object', 'symbol', 'bigint', 'undefined', 'never',
  'any', 'unknown', 'void', 'null', 'Array', 'Promise', 'Record', 'Partial',
  'Required', 'Readonly', 'Pick', 'Omit', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Date', 'Error', 'RegExp', 'Function', 'Awaited', 'ReturnType', 'Parameters',
];

const JAVA_KEYWORDS = [
  ...C_KEYWORDS, 'class', 'extends', 'implements', 'interface', 'new', 'this', 'super',
  'try', 'catch', 'finally', 'throw', 'throws', 'import', 'package', 'public',
  'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'volatile',
  'transient', 'native', 'strictfp', 'assert', 'enum', 'instanceof', 'var', 'record',
  'sealed', 'permits', 'yield', 'when',
];

const JAVA_TYPES = [
  'void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double',
  'String', 'Object', 'Integer', 'Long', 'Boolean', 'Double', 'Float', 'List',
  'Map', 'Set', 'Optional', 'Stream',
];

const GO_KEYWORDS = [
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
  'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type',
  'var',
];

const GO_TYPES = [
  'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64',
  'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8',
  'uint16', 'uint32', 'uint64', 'uintptr', 'any', 'comparable',
];

const RUST_KEYWORDS = [
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
  'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
  'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
  'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use',
  'where', 'while', 'abstract', 'become', 'box', 'do', 'final', 'macro',
  'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try',
];

const RUST_TYPES = [
  'bool', 'char', 'str', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64', 'String',
  'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'Cell', 'RefCell',
];

const PYTHON_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  'match', 'case', 'type',
];

const PYTHON_TYPES = [
  'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes',
  'Any', 'Optional', 'Union', 'List', 'Dict', 'Set', 'Tuple', 'Callable',
  'Iterable', 'Iterator', 'Mapping', 'Sequence', 'Type', 'ClassVar', 'Final',
  'Literal', 'TypedDict', 'Self', 'Never', 'NoReturn',
];

const RUBY_KEYWORDS = [
  'BEGIN', 'END', 'alias', 'and', 'begin', 'break', 'case', 'class', 'def',
  'defined?', 'do', 'else', 'elsif', 'end', 'ensure', 'false', 'for', 'if',
  'in', 'module', 'next', 'nil', 'not', 'or', 'redo', 'rescue', 'retry',
  'return', 'self', 'super', 'then', 'true', 'undef', 'unless', 'until',
  'when', 'while', 'yield',
];

const SHELL_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while',
  'until', 'do', 'done', 'in', 'function', 'time', 'coproc', 'return', 'exit',
  'export', 'local', 'readonly', 'declare', 'typeset', 'unset', 'shift',
  'source', 'alias', 'unalias', 'set', 'trap', 'wait', 'jobs', 'fg', 'bg',
  'true', 'false', 'test',
];

const SQL_KEYWORDS = [
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'as',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'using',
  'group', 'by', 'order', 'having', 'limit', 'offset', 'insert', 'into',
  'values', 'update', 'set', 'delete', 'create', 'table', 'index', 'view',
  'drop', 'alter', 'add', 'column', 'primary', 'key', 'foreign', 'references',
  'unique', 'check', 'default', 'constraint', 'distinct', 'all', 'union',
  'except', 'intersect', 'exists', 'between', 'like', 'ilike', 'case', 'when',
  'then', 'else', 'end', 'with', 'recursive', 'over', 'partition', 'window',
  'asc', 'desc', 'nulls', 'first', 'last', 'true', 'false', 'cast', 'coalesce',
];

const CSS_KEYWORDS = [
  'important', 'from', 'to', 'and', 'or', 'not', 'only', 'screen', 'print',
  'var', 'calc', 'url', 'rgb', 'rgba', 'hsl', 'hsla',
];

const HTML_KEYWORDS = [
  'html', 'head', 'body', 'div', 'span', 'script', 'style', 'link', 'meta',
  'title', 'header', 'footer', 'main', 'nav', 'section', 'article', 'aside',
  'p', 'a', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'form', 'input', 'button', 'label', 'select', 'option', 'textarea', 'img',
  'svg', 'path', 'canvas', 'template', 'slot', 'component',
];

function setOf(...groups: readonly (readonly string[])[]): ReadonlySet<string> {
  return new Set(groups.flat());
}

const PROFILES: Record<string, LanguageProfile> = {
  ts: {
    family: 'clike',
    keywords: setOf(JS_KEYWORDS),
    types: setOf(JS_TYPES),
    literals: setOf(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  js: {
    family: 'clike',
    keywords: setOf(JS_KEYWORDS.filter((k) => !['type', 'interface', 'implements', 'namespace', 'declare', 'keyof', 'infer', 'satisfies', 'asserts'].includes(k))),
    types: setOf(['Array', 'Promise', 'Map', 'Set', 'Date', 'Error', 'RegExp', 'Function', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt']),
    literals: setOf(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  java: {
    family: 'clike',
    keywords: setOf(JAVA_KEYWORDS),
    types: setOf(JAVA_TYPES),
    literals: setOf(['true', 'false', 'null']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  kt: {
    family: 'clike',
    keywords: setOf([
      'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if',
      'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super',
      'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when',
      'while', 'by', 'catch', 'constructor', 'delegate', 'dynamic', 'field',
      'file', 'finally', 'get', 'import', 'init', 'param', 'property', 'receiver',
      'set', 'setparam', 'where', 'actual', 'abstract', 'annotation', 'companion',
      'const', 'crossinline', 'data', 'enum', 'expect', 'external', 'final',
      'infix', 'inline', 'inner', 'internal', 'lateinit', 'noinline', 'open',
      'operator', 'out', 'override', 'private', 'protected', 'public', 'reified',
      'sealed', 'suspend', 'tailrec', 'vararg',
    ]),
    types: setOf(['Int', 'Long', 'Short', 'Byte', 'Boolean', 'Char', 'Float', 'Double', 'String', 'Unit', 'Any', 'Nothing', 'List', 'Map', 'Set', 'Array']),
    literals: setOf(['true', 'false', 'null']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  swift: {
    family: 'clike',
    keywords: setOf([
      'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate',
      'func', 'import', 'init', 'inout', 'internal', 'let', 'open', 'operator',
      'private', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript',
      'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do',
      'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return',
      'switch', 'where', 'while', 'as', 'Any', 'catch', 'false', 'is', 'nil',
      'super', 'self', 'Self', 'throw', 'throws', 'true', 'try', 'async', 'await',
      'actor', 'some', 'opaque',
    ]),
    types: setOf(['Int', 'Double', 'Float', 'String', 'Bool', 'Character', 'Array', 'Dictionary', 'Set', 'Optional', 'Void', 'Result', 'Error']),
    literals: setOf(['true', 'false', 'nil']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  c: {
    family: 'clike',
    keywords: setOf(C_KEYWORDS),
    types: setOf(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', 'bool', 'size_t', 'ptrdiff_t', 'wchar_t', 'FILE']),
    literals: setOf(['true', 'false', 'NULL']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  cpp: {
    family: 'clike',
    keywords: setOf([
      ...C_KEYWORDS, 'class', 'public', 'private', 'protected', 'virtual', 'friend',
      'template', 'typename', 'namespace', 'using', 'try', 'catch', 'throw', 'new',
      'delete', 'this', 'operator', 'const_cast', 'dynamic_cast', 'reinterpret_cast',
      'static_cast', 'mutable', 'explicit', 'export', 'wchar_t', 'constexpr',
      'decltype', 'noexcept', 'nullptr', 'static_assert', 'thread_local', 'alignas',
      'alignof', 'concept', 'requires', 'co_await', 'co_return', 'co_yield',
    ]),
    types: setOf(['void', 'bool', 'char', 'int', 'long', 'float', 'double', 'short', 'unsigned', 'signed', 'size_t', 'string', 'vector', 'map', 'set', 'auto']),
    literals: setOf(['true', 'false', 'nullptr', 'NULL']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  csharp: {
    family: 'clike',
    keywords: setOf([
      'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char',
      'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate',
      'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false',
      'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit',
      'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace',
      'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private',
      'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed',
      'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch',
      'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked',
      'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while', 'async',
      'await', 'var', 'dynamic', 'nameof', 'when', 'yield', 'record', 'init',
      'required', 'file', 'scoped',
    ]),
    types: setOf(['string', 'int', 'long', 'bool', 'object', 'void', 'double', 'float', 'decimal', 'Task', 'List', 'Dictionary', 'IEnumerable', 'Action', 'Func']),
    literals: setOf(['true', 'false', 'null']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  go: {
    family: 'go',
    keywords: setOf(GO_KEYWORDS),
    types: setOf(GO_TYPES),
    literals: setOf(['true', 'false', 'nil', 'iota']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  rust: {
    family: 'rust',
    keywords: setOf(RUST_KEYWORDS),
    types: setOf(RUST_TYPES),
    literals: setOf(['true', 'false', 'Some', 'None', 'Ok', 'Err']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  python: {
    family: 'python',
    keywords: setOf(PYTHON_KEYWORDS),
    types: setOf(PYTHON_TYPES),
    literals: setOf(['True', 'False', 'None']),
    lineComment: '#',
    tripleQuotes: true,
  },
  ruby: {
    family: 'ruby',
    keywords: setOf(RUBY_KEYWORDS),
    types: setOf(['String', 'Integer', 'Float', 'Array', 'Hash', 'Symbol', 'NilClass', 'TrueClass', 'FalseClass']),
    literals: setOf(['true', 'false', 'nil']),
    lineComment: '#',
  },
  shell: {
    family: 'shell',
    keywords: setOf(SHELL_KEYWORDS),
    types: setOf([]),
    literals: setOf(['true', 'false']),
    hashComment: true,
  },
  sql: {
    family: 'sql',
    keywords: setOf(SQL_KEYWORDS),
    types: setOf(['int', 'integer', 'bigint', 'smallint', 'varchar', 'char', 'text', 'boolean', 'bool', 'date', 'time', 'timestamp', 'numeric', 'decimal', 'float', 'double', 'real', 'json', 'jsonb', 'uuid']),
    literals: setOf(['true', 'false', 'null']),
    lineComment: '--',
    blockComment: ['/*', '*/'],
  },
  json: {
    family: 'json',
    keywords: setOf([]),
    types: setOf([]),
    literals: setOf(['true', 'false', 'null']),
  },
  yaml: {
    family: 'yaml',
    keywords: setOf(['true', 'false', 'null', 'yes', 'no', 'on', 'off']),
    types: setOf([]),
    literals: setOf(['true', 'false', 'null', 'yes', 'no', 'on', 'off']),
    hashComment: true,
  },
  html: {
    family: 'html',
    keywords: setOf(HTML_KEYWORDS),
    types: setOf([]),
    literals: setOf([]),
    blockComment: ['<!--', '-->'],
  },
  xml: {
    family: 'html',
    keywords: setOf([]),
    types: setOf([]),
    literals: setOf([]),
    blockComment: ['<!--', '-->'],
  },
  css: {
    family: 'css',
    keywords: setOf(CSS_KEYWORDS),
    types: setOf([]),
    literals: setOf(['true', 'false', 'null', 'inherit', 'initial', 'unset', 'none', 'auto']),
    blockComment: ['/*', '*/'],
  },
  scss: {
    family: 'css',
    keywords: setOf(CSS_KEYWORDS),
    types: setOf([]),
    literals: setOf(['true', 'false', 'null', 'inherit', 'initial', 'unset', 'none', 'auto']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  php: {
    family: 'clike',
    keywords: setOf([
      'abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch',
      'class', 'clone', 'const', 'continue', 'declare', 'default', 'do', 'echo',
      'else', 'elseif', 'empty', 'enddeclare', 'endfor', 'endforeach', 'endif',
      'endswitch', 'endwhile', 'extends', 'final', 'finally', 'fn', 'for',
      'foreach', 'function', 'global', 'goto', 'if', 'implements', 'include',
      'include_once', 'instanceof', 'insteadof', 'interface', 'isset', 'list',
      'match', 'namespace', 'new', 'or', 'print', 'private', 'protected',
      'public', 'readonly', 'require', 'require_once', 'return', 'static',
      'switch', 'throw', 'trait', 'try', 'unset', 'use', 'var', 'while', 'xor',
      'yield', 'from',
    ]),
    types: setOf(['int', 'float', 'string', 'bool', 'array', 'object', 'callable', 'iterable', 'void', 'mixed', 'never', 'true', 'false', 'null']),
    literals: setOf(['true', 'false', 'null', 'TRUE', 'FALSE', 'NULL']),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
};

const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  javascript: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  node: 'js',
  golang: 'go',
  rs: 'rust',
  py: 'python',
  python3: 'python',
  rb: 'ruby',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shellscript: 'shell',
  ps1: 'shell',
  powershell: 'shell',
  yml: 'yaml',
  md: 'plain',
  markdown: 'plain',
  text: 'plain',
  txt: 'plain',
  plaintext: 'plain',
  cplusplus: 'cpp',
  'c++': 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  kotlin: 'kt',
  kts: 'kt',
  mysql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  plsql: 'sql',
  tsql: 'sql',
  htm: 'html',
  xhtml: 'html',
  svg: 'xml',
  less: 'scss',
  sass: 'scss',
  jsonc: 'json',
  json5: 'json',
  toml: 'yaml',
  ini: 'yaml',
  conf: 'shell',
  dockerfile: 'shell',
  docker: 'shell',
  make: 'shell',
  makefile: 'shell',
  graphql: 'js',
  gql: 'js',
  proto: 'js',
  protobuf: 'js',
  lua: 'ruby',
  r: 'python',
  scala: 'java',
  dart: 'java',
  objectivec: 'c',
  'objective-c': 'c',
  objc: 'c',
};

function normalizeLanguage(language: string | undefined | null): string {
  const raw = (language ?? '').trim().toLowerCase();
  if (!raw) return '';
  // fence info strings like `ts title="x"` → ts
  const primary = raw.split(/[\s,{(:]/)[0] ?? raw;
  return LANGUAGE_ALIASES[primary] ?? primary;
}

function resolveProfile(language: string | undefined | null): LanguageProfile | null {
  const key = normalizeLanguage(language);
  if (!key || key === 'diff' || key === 'plain') return null;
  if (PROFILES[key]) return PROFILES[key]!;
  // last-chance: treat unknown as clike-ish with empty keyword sets so strings/comments still work if // present
  return {
    family: 'plain',
    keywords: setOf([]),
    types: setOf([]),
    literals: setOf([]),
    lineComment: '//',
    blockComment: ['/*', '*/'],
  };
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function pushToken(tokens: SyntaxToken[], kind: SyntaxTokenKind, text: string): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  tokens.push({ kind, text });
}

function tokenizeHtml(source: string, profile: LanguageProfile): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      const close = end === -1 ? source.length : end + 3;
      pushToken(tokens, 'comment', source.slice(i, close));
      i = close;
      continue;
    }
    if (source[i] === '<') {
      const end = source.indexOf('>', i + 1);
      const close = end === -1 ? source.length : end + 1;
      const tag = source.slice(i, close);
      // crude tag highlight: punctuation + name + attrs strings
      let j = 0;
      while (j < tag.length) {
        if (tag[j] === '"' || tag[j] === "'") {
          const q = tag[j]!;
          let k = j + 1;
          while (k < tag.length && tag[k] !== q) {
            if (tag[k] === '\\') k += 1;
            k += 1;
          }
          if (k < tag.length) k += 1;
          pushToken(tokens, 'string', tag.slice(j, k));
          j = k;
          continue;
        }
        if (/[A-Za-z_:]/.test(tag[j]!)) {
          let k = j + 1;
          while (k < tag.length && /[A-Za-z0-9_.:-]/.test(tag[k]!)) k += 1;
          const word = tag.slice(j, k);
          const kind: SyntaxTokenKind = profile.keywords.has(word.toLowerCase()) || profile.keywords.has(word)
            ? 'keyword'
            : (word.startsWith('/') ? 'keyword' : 'type');
          pushToken(tokens, kind, word);
          j = k;
          continue;
        }
        pushToken(tokens, 'punctuation', tag[j]!);
        j += 1;
      }
      i = close;
      continue;
    }
    let j = i + 1;
    while (j < source.length && source[j] !== '<' && !source.startsWith('<!--', j)) j += 1;
    pushToken(tokens, 'plain', source.slice(i, j));
    i = j;
  }
  return tokens;
}

function tokenizeJson(source: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j]!)) j += 1;
      pushToken(tokens, 'plain', source.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '"' ) {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '"') { j += 1; break; }
        j += 1;
      }
      const text = source.slice(i, j);
      // property if followed by :
      let k = j;
      while (k < source.length && /\s/.test(source[k]!)) k += 1;
      pushToken(tokens, source[k] === ':' ? 'property' : 'string', text);
      i = j;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      pushToken(tokens, 'number', source.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < source.length && isIdentPart(source[j]!)) j += 1;
      const word = source.slice(i, j);
      pushToken(tokens, ['true', 'false', 'null'].includes(word) ? 'literal' : 'plain', word);
      i = j;
      continue;
    }
    pushToken(tokens, /[{}[\]:,]/.test(ch) ? 'punctuation' : 'plain', ch);
    i += 1;
  }
  return tokens;
}

function readString(source: string, start: number, quote: string, triple: boolean): number {
  if (triple) {
    let i = start + 3;
    while (i < source.length) {
      if (source.startsWith(quote.repeat(3), i)) return i + 3;
      if (source[i] === '\\') i += 2;
      else i += 1;
    }
    return source.length;
  }
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    if (source[i] === '\n' && quote !== '`') return i;
    i += 1;
  }
  return source.length;
}

function tokenizeGeneric(source: string, profile: LanguageProfile): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let i = 0;
  const lineComment = profile.hashComment ? '#' : profile.lineComment;
  const block = profile.blockComment;

  while (i < source.length) {
    // block comment
    if (block && source.startsWith(block[0], i)) {
      const end = source.indexOf(block[1], i + block[0].length);
      const close = end === -1 ? source.length : end + block[1].length;
      pushToken(tokens, 'comment', source.slice(i, close));
      i = close;
      continue;
    }

    // line comment
    if (lineComment && source.startsWith(lineComment, i)) {
      let j = i + lineComment.length;
      while (j < source.length && source[j] !== '\n') j += 1;
      pushToken(tokens, 'comment', source.slice(i, j));
      i = j;
      continue;
    }

    // triple quotes (python)
    if (profile.tripleQuotes && (source.startsWith('"""', i) || source.startsWith("'''", i))) {
      const q = source.slice(i, i + 3);
      const end = readString(source, i, q[0]!, true);
      pushToken(tokens, 'string', source.slice(i, end));
      i = end;
      continue;
    }

    // template / normal strings
    const ch = source[i]!;
    if (ch === '`' || ch === '"' || ch === "'") {
      // python raw/f/b prefixes already handled as ident before quote in most cases;
      // also allow r"/f" prefixes attached: if previous was plain letter, still ok as string start here only on quote
      const end = readString(source, i, ch, false);
      pushToken(tokens, 'string', source.slice(i, end));
      i = end;
      continue;
    }

    // regex after = ( or , : return  for js-ish — keep simple: /.../ when not comment
    if (ch === '/' && profile.family === 'clike' && !source.startsWith('//', i) && !source.startsWith('/*', i)) {
      const prev = tokens[tokens.length - 1];
      const prevText = prev?.text.trimEnd() ?? '';
      const allowRegex = !prev
        || prev.kind === 'operator'
        || prev.kind === 'punctuation'
        || prev.kind === 'keyword'
        || /[=(:,;!?&|+\-~^%*[{\n]$/.test(prevText);
      if (allowRegex) {
        let j = i + 1;
        let closed = false;
        while (j < source.length) {
          if (source[j] === '\\') { j += 2; continue; }
          if (source[j] === '\n') break;
          if (source[j] === '/') { j += 1; closed = true; break; }
          j += 1;
        }
        if (closed) {
          while (j < source.length && /[gimsuy]/.test(source[j]!)) j += 1;
          pushToken(tokens, 'string', source.slice(i, j));
          i = j;
          continue;
        }
      }
    }

    // whitespace
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j]!)) j += 1;
      pushToken(tokens, 'plain', source.slice(i, j));
      i = j;
      continue;
    }

    // numbers
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source.startsWith('0x', i) || source.startsWith('0X', i) || source.startsWith('0b', i) || source.startsWith('0B', i) || source.startsWith('0o', i) || source.startsWith('0O', i)) {
        j += 2;
        while (j < source.length && /[0-9a-fA-F_]/.test(source[j]!)) j += 1;
      } else {
        while (j < source.length && /[0-9_]/.test(source[j]!)) j += 1;
        if (source[j] === '.') {
          j += 1;
          while (j < source.length && /[0-9_]/.test(source[j]!)) j += 1;
        }
        if (source[j] === 'e' || source[j] === 'E') {
          j += 1;
          if (source[j] === '+' || source[j] === '-') j += 1;
          while (j < source.length && /[0-9_]/.test(source[j]!)) j += 1;
        }
        while (j < source.length && /[nNulLfFdD]/.test(source[j]!)) j += 1;
      }
      pushToken(tokens, 'number', source.slice(i, j));
      i = j;
      continue;
    }

    // identifiers
    if (isIdentStart(ch) || (profile.family === 'rust' && ch === "'")) {
      // rust lifetimes: 'a
      if (profile.family === 'rust' && ch === "'") {
        let j = i + 1;
        if (j < source.length && isIdentStart(source[j]!)) {
          j += 1;
          while (j < source.length && isIdentPart(source[j]!)) j += 1;
          pushToken(tokens, 'type', source.slice(i, j));
          i = j;
          continue;
        }
      }
      let j = i + 1;
      while (j < source.length && isIdentPart(source[j]!)) j += 1;
      // python string prefixes: rf"..." f''' etc
      if (profile.tripleQuotes || profile.family === 'python') {
        const prefix = source.slice(i, j).toLowerCase();
        if (/^[frbu]+$/.test(prefix) && (source[j] === '"' || source[j] === "'")) {
          // include prefix in string token
          const q = source[j]!;
          const triple = source.startsWith(q.repeat(3), j);
          const end = readString(source, j, q, triple);
          pushToken(tokens, 'string', source.slice(i, end));
          i = end;
          continue;
        }
      }
      const word = source.slice(i, j);
      let k = j;
      while (k < source.length && /\s/.test(source[k]!)) k += 1;
      const next = source[k];
      let kind: SyntaxTokenKind = 'plain';
      const wordKey = profile.family === 'sql' ? word.toLowerCase() : word;
      if (profile.literals.has(word) || profile.literals.has(wordKey)) kind = 'literal';
      else if (profile.keywords.has(word) || profile.keywords.has(wordKey)) kind = 'keyword';
      else if (profile.types.has(word) || profile.types.has(wordKey)) kind = 'type';
      else if (/^[A-Z]/.test(word) && profile.family !== 'shell') kind = 'type';
      else if (next === '(') kind = 'function';
      pushToken(tokens, kind, word);
      i = j;
      continue;
    }

    // operators / punctuation (multi-char first)
    const two = source.slice(i, i + 2);
    const three = source.slice(i, i + 3);
    if (['===', '!==', '>>>', '<<=', '>>=', '**=', '&&=', '||=', '??=', '...'].includes(three)) {
      pushToken(tokens, 'operator', three);
      i += 3;
      continue;
    }
    if ([
      '==', '!=', '<=', '>=', '=>', '->', '::', '&&', '||', '??', '++', '--',
      '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**', '..',
    ].includes(two)) {
      pushToken(tokens, 'operator', two);
      i += 2;
      continue;
    }
    if (/[{}()[\].,;:?]/.test(ch)) {
      pushToken(tokens, 'punctuation', ch);
      i += 1;
      continue;
    }
    if (/[+\-*/%<>=!&|^~@#]/.test(ch)) {
      pushToken(tokens, 'operator', ch);
      i += 1;
      continue;
    }

    pushToken(tokens, 'plain', ch);
    i += 1;
  }

  return tokens;
}

export function highlightCode(source: string, language?: string | null): SyntaxToken[] {
  const text = source || '';
  if (!text) return [{ kind: 'plain', text: ' ' }];
  const key = normalizeLanguage(language);
  if (key === 'diff') return [{ kind: 'plain', text }];
  const profile = resolveProfile(language);
  if (!profile) return [{ kind: 'plain', text }];
  try {
    if (profile.family === 'html') return tokenizeHtml(text, profile);
    if (profile.family === 'json') return tokenizeJson(text);
    return tokenizeGeneric(text, profile);
  } catch {
    return [{ kind: 'plain', text }];
  }
}

export function isHighlightableLanguage(language?: string | null): boolean {
  const key = normalizeLanguage(language);
  return Boolean(key) && key !== 'diff';
}

export { normalizeLanguage };
