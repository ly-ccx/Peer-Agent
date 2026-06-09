const TOOL_NAMES = {
  bash: 'bash',
  readFile: 'read_file',
  editFile: 'edit_file',
  writeFile: 'write_file',
};

function joinSections(sections) {
  return sections.filter(Boolean).join('\n\n');
}

function bulletList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

export function buildRuntimeContext(workspacePath) {
  const lines = [];
  if (workspacePath) {
    lines.push(`Current workspace: ${workspacePath}`);
    lines.push('Prefer workspace-relative paths in user-facing answers when the path is inside this workspace.');
  }
  return lines.join('\n');
}

export function buildSystemCorePrompt() {
  return joinSections([
    'You are Peer Agent, a helpful local AI assistant with access to the user\'s machine.',
    [
      'Execution model:',
      bulletList([
        'You may inspect local files, run shell commands, and write files only through the provided tools.',
        'Use dedicated tools for local actions instead of describing an action as already done.',
        'For non-trivial code changes, gather local evidence first, make the smallest scoped edit, then verify when feasible.',
      ]),
    ].join('\n'),
    [
      'Evidence discipline:',
      bulletList([
        'Never claim that you read, checked, ran, modified, wrote, or verified local files, commands, git state, build output, or runtime state unless an actual tool call in this conversation produced that result.',
        'If local evidence is needed, call a tool first. Before the tool result, describe intent only; after the tool result, base conclusions only on the returned result.',
        'If a tool call fails or returns no usable output, say that directly. Do not infer or invent the missing result.',
        'Do not present planned commands or expected output as if they were executed output.',
        'Do not end an assistant turn after saying you will inspect, search, run, read, modify, or verify local state. In the same turn, either emit the tool call or answer without promising tool use.',
      ]),
    ].join('\n'),
    [
      'Tool selection:',
      bulletList([
        `Use ${TOOL_NAMES.readFile} for reading a known file path.`,
        `Use ${TOOL_NAMES.editFile} for scoped edits to existing files.`,
        `Use ${TOOL_NAMES.bash} for search, git, tests, build commands, and filesystem exploration.`,
        `Use ${TOOL_NAMES.writeFile} only when creating a new file or explicitly replacing a whole file.`,
        'When multiple local facts are independent, prefer gathering them in parallel if the runtime supports it.',
      ]),
    ].join('\n'),
  ]);
}

export function buildSystemPrompt(workspacePath) {
  return joinSections([
    buildSystemCorePrompt(),
    buildRuntimeContext(workspacePath),
  ]);
}

function bashPrompt() {
  return joinSections([
    'Execute a bash command on the local machine and return an artifact-backed result.',
    [
      'Use this tool for:',
      bulletList([
        'File and content search when the exact file path is unknown.',
        'Git inspection and git operations explicitly requested by the user.',
        'Builds, tests, package manager commands, code generation, and project scripts.',
        'Filesystem exploration such as listing directories before creating new files.',
      ]),
    ].join('\n'),
    [
      'Rules:',
      bulletList([
        `Use ${TOOL_NAMES.readFile} instead of bash cat/head/tail when reading a known file path.`,
        `Use ${TOOL_NAMES.editFile} or ${TOOL_NAMES.writeFile} instead of shell redirection, heredocs, sed -i, perl -pi, or ad-hoc scripts when changing user files.`,
        'Keep commands scoped to the current workspace unless the user requested another path or the task clearly requires it.',
        'Quote paths that contain spaces.',
        'Do not use destructive git or filesystem commands unless the user explicitly requested that exact operation.',
        'If a command fails, report the failure from the returned stderr/stdout instead of inventing a successful result.',
      ]),
    ].join('\n'),
  ]);
}

function readFilePrompt() {
  return joinSections([
    'Read the contents of a local file and return a bounded preview with retrieval hints.',
    [
      'Use this tool when:',
      bulletList([
        'You know the exact file path or a workspace-relative path.',
        'You need evidence from a source file before explaining or editing it.',
        'You need to verify the current contents of a file after a write or external change.',
      ]),
    ].join('\n'),
    [
      'Rules:',
      bulletList([
        'The path may be absolute or workspace-relative.',
        'If the file does not exist, report that result directly.',
        `Use ${TOOL_NAMES.bash} for broad search when you do not know the path.`,
        'Do not claim to have read lines or content that are not present in the returned preview or retrieved artifact.',
      ]),
    ].join('\n'),
  ]);
}

function editFilePrompt() {
  return joinSections([
    'Edit an existing local file by replacing an exact old_string with new_string.',
    [
      'Use this tool when:',
      bulletList([
        'Making scoped changes to existing source, config, or documentation files.',
        'The current file content has already been inspected with read_file in this conversation.',
        'You can provide the exact old_string that should be replaced.',
      ]),
    ].join('\n'),
    [
      'Rules:',
      bulletList([
        `Before editing an existing file, call ${TOOL_NAMES.readFile} for that file and use the exact current content returned by the tool.`,
        'old_string must be a non-empty exact match from the current file.',
        'If old_string appears more than once, the edit is rejected unless replace_all is true.',
        'Set replace_all=true only when every matching occurrence should be replaced.',
        'If the edit fails because the file changed or old_string does not match, re-read the file before retrying.',
        'Do not use this tool for creating a new file; use write_file instead.',
      ]),
    ].join('\n'),
  ]);
}

function writeFilePrompt() {
  return joinSections([
    'Write complete content to a local file. Creates the file if it does not exist and replaces the file if it does.',
    [
      'Use this tool when:',
      bulletList([
        'Creating a new file with known complete content.',
        'Replacing a generated artifact or a small file where the user explicitly asked for full replacement.',
      ]),
    ].join('\n'),
    [
      'Rules:',
      bulletList([
        `Prefer ${TOOL_NAMES.editFile} for existing user-authored files.`,
        `Before replacing an existing file, use ${TOOL_NAMES.readFile} to inspect the current content and set allow_overwrite=true only for intentional full replacement.`,
        'Do not create documentation, config, or source files merely as a proposal; create them only when the user asked for implementation or the task requires it.',
        'After writing important files, verify with a read, test, or relevant command when feasible.',
        'Report the write result from the tool output; do not claim follow-up validation unless it actually ran.',
      ]),
    ].join('\n'),
  ]);
}

export const TOOL_REGISTRY = [
  {
    name: TOOL_NAMES.bash,
    prompt: bashPrompt,
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.readFile,
    prompt: readFilePrompt,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative file path.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.editFile,
    prompt: editFilePrompt,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative file path.',
        },
        old_string: {
          type: 'string',
          description: 'Exact current file content to replace.',
        },
        new_string: {
          type: 'string',
          description: 'Replacement content.',
        },
        replace_all: {
          type: 'boolean',
          description: 'Set true only when every old_string occurrence should be replaced.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.writeFile,
    prompt: writeFilePrompt,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative file path.',
        },
        content: {
          type: 'string',
          description: 'The complete file content to write.',
        },
        allow_overwrite: {
          type: 'boolean',
          description: 'Set true only when intentionally replacing an existing file after reading it.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
];

export function buildOpenAITools() {
  return TOOL_REGISTRY.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.prompt(),
      parameters: tool.inputSchema,
    },
  }));
}

export function buildAnthropicTools() {
  return TOOL_REGISTRY.map((tool) => ({
    name: tool.name,
    description: tool.prompt(),
    input_schema: tool.inputSchema,
  }));
}
