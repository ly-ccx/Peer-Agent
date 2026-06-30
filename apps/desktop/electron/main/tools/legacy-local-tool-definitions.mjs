import { readFileSync } from 'node:fs';

export const TOOL_NAMES = {
  bash: 'bash',
  readFile: 'read_file',
  searchFiles: 'search_files',
  editFile: 'edit_file',
  writeFile: 'write_file',
};

const promptAssetCache = new Map();

function readPromptAsset(filename) {
  if (!promptAssetCache.has(filename)) {
    promptAssetCache.set(filename, readFileSync(new URL(`./prompts/${filename}`, import.meta.url), 'utf8').trim());
  }
  return promptAssetCache.get(filename);
}

const LEGACY_RUNTIME = Object.freeze({
  adapter: 'runtime-gateway.legacy-llm-local-tool-provider',
  migrationTarget: 'runtime-gateway.local-tool-host',
});

function legacyRuntime(executorCapabilityId) {
  return Object.freeze({
    ...LEGACY_RUNTIME,
    executorCapabilityId,
  });
}

export const LEGACY_LOCAL_TOOL_DEFINITIONS = [
  {
    name: TOOL_NAMES.bash,
    capabilityId: 'legacy.local.shell.exec',
    prompt: () => readPromptAsset('bash.txt'),
    // Explorer 第一版只允许结构化文件读取，不投影通用 shell。
    availableInModes: ['chat', 'plan'],
    runtime: legacyRuntime('local.shell.exec'),
    permissionPolicy: {
      kind: 'shell',
      requiresReviewForWrites: true,
    },
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
    capabilityId: 'legacy.local.file.read',
    prompt: () => readPromptAsset('read_file.txt'),
    availableInModes: ['chat', 'plan', 'explorer'],
    runtime: legacyRuntime('local.file.read'),
    permissionPolicy: {
      kind: 'file-read',
      requiresReviewForOutsideWorkspace: false,
    },
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
    name: TOOL_NAMES.searchFiles,
    capabilityId: 'legacy.local.file.search',
    prompt: () => readPromptAsset('search_files.txt'),
    // 只读搜索：Explorer 子 Agent 可用，用于在 workspace 内按内容定位文件。
    availableInModes: ['chat', 'plan', 'explorer'],
    runtime: legacyRuntime('local.file.search'),
    permissionPolicy: {
      kind: 'file-read',
      requiresReviewForOutsideWorkspace: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to search for in file contents.',
        },
        path: {
          type: 'string',
          description:
            'Optional workspace-relative or absolute directory to scope the search. Must stay inside the workspace. Defaults to the workspace root.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Set true for case-sensitive matching. Defaults to false.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of matching lines to return (1-200, default 50).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.editFile,
    capabilityId: 'legacy.local.file.edit',
    prompt: () => readPromptAsset('edit_file.txt'),
    availableInModes: ['chat', 'plan'],
    runtime: legacyRuntime('local.file.edit'),
    permissionPolicy: {
      kind: 'file-write',
      requiresFreshRead: true,
      requiresReviewForOutsideWorkspace: true,
    },
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
    capabilityId: 'legacy.local.file.write',
    prompt: () => readPromptAsset('write_file.txt'),
    availableInModes: ['chat', 'plan'],
    runtime: legacyRuntime('local.file.write'),
    permissionPolicy: {
      kind: 'file-write',
      requiresFreshReadForOverwrite: true,
      requiresReviewForOutsideWorkspace: true,
    },
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
