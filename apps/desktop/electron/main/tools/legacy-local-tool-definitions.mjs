import { readFileSync } from 'node:fs';

import { SHARED_LOCAL_TOOL_CONTRACTS } from '@peer-agent/runtime-core';

export const TOOL_NAMES = {
  bash: SHARED_LOCAL_TOOL_CONTRACTS.shellExec.toolName,
  shellStop: SHARED_LOCAL_TOOL_CONTRACTS.shellStop.toolName,
  readFile: SHARED_LOCAL_TOOL_CONTRACTS.readFile.toolName,
  listFiles: SHARED_LOCAL_TOOL_CONTRACTS.listFiles.toolName,
  searchFiles: SHARED_LOCAL_TOOL_CONTRACTS.searchFiles.toolName,
  editFile: SHARED_LOCAL_TOOL_CONTRACTS.editFile.toolName,
  writeFile: SHARED_LOCAL_TOOL_CONTRACTS.writeFile.toolName,
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
    availableInModes: ['chat', 'goal'],
    runtime: legacyRuntime(SHARED_LOCAL_TOOL_CONTRACTS.shellExec.capabilityId),
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
    name: TOOL_NAMES.shellStop,
    capabilityId: 'legacy.local.shell.stop',
    prompt: () => 'Stop a running background shell task by task id or tool call id. When neither is provided, stop the active shell task.',
    availableInModes: ['chat', 'goal'],
    runtime: legacyRuntime(SHARED_LOCAL_TOOL_CONTRACTS.shellStop.capabilityId),
    permissionPolicy: {
      kind: 'shell',
      requiresReviewForWrites: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Background shell task id.',
        },
        toolCallId: {
          type: 'string',
          description: 'Tool call id that started the shell task.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.listFiles,
    capabilityId: 'legacy.local.file.list',
    prompt: () => 'List the immediate entries in a directory. Use this instead of shell commands when you only need directory contents.',
    availableInModes: ['chat', 'plan', 'explorer', 'goal'],
    runtime: legacyRuntime(SHARED_LOCAL_TOOL_CONTRACTS.listFiles.capabilityId),
    permissionPolicy: {
      kind: 'file-read',
      requiresReviewForOutsideWorkspace: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative directory path. Defaults to the workspace root.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.readFile,
    capabilityId: 'legacy.local.file.read',
    prompt: () => readPromptAsset('read_file.txt'),
    availableInModes: ['chat', 'plan', 'explorer', 'goal'],
    runtime: legacyRuntime(SHARED_LOCAL_TOOL_CONTRACTS.readFile.capabilityId),
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
    availableInModes: ['chat', 'plan', 'explorer', 'goal'],
    runtime: legacyRuntime(SHARED_LOCAL_TOOL_CONTRACTS.searchFiles.capabilityId),
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
            'Optional workspace-relative or absolute directory to scope the search. Absolute paths may point outside the session workspace (e.g. cross-repository investigation). Defaults to the workspace root.',
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
    availableInModes: ['chat', 'goal'],
    runtime: legacyRuntime(SHARED_LOCAL_TOOL_CONTRACTS.editFile.capabilityId),
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
    availableInModes: ['chat', 'goal'],
    runtime: legacyRuntime(SHARED_LOCAL_TOOL_CONTRACTS.writeFile.capabilityId),
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
