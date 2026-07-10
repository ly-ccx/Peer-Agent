import type {
  RuntimeJsonObject,
  RuntimeModeScope,
  RuntimeProjection,
  RuntimeToolDefinition,
} from './contracts.ts';

export type RuntimeProjectionErrorCode =
  | 'invalid_tool_definition'
  | 'duplicate_tool_name';

export class RuntimeProjectionError extends Error {
  readonly code: RuntimeProjectionErrorCode;

  constructor(message: string, code: RuntimeProjectionErrorCode) {
    super(message);
    this.name = 'RuntimeProjectionError';
    this.code = code;
  }
}

export interface CreateRuntimeProjectionOptions {
  readonly mode?: RuntimeModeScope | null;
  readonly createdAt?: string;
  readonly now?: () => string;
  readonly metadata?: RuntimeJsonObject;
}

function assertToolDefinition(tool: RuntimeToolDefinition): void {
  if (!tool || typeof tool !== 'object') {
    throw new RuntimeProjectionError(
      'Runtime tool definition must be an object.',
      'invalid_tool_definition',
    );
  }
  if (typeof tool.name !== 'string' || tool.name.trim().length === 0) {
    throw new RuntimeProjectionError(
      'Runtime tool definition must declare a non-empty name.',
      'invalid_tool_definition',
    );
  }
  if (typeof tool.capabilityId !== 'string' || tool.capabilityId.trim().length === 0) {
    throw new RuntimeProjectionError(
      `Runtime tool definition ${tool.name} must declare a non-empty capabilityId.`,
      'invalid_tool_definition',
    );
  }
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    throw new RuntimeProjectionError(
      `Runtime tool definition ${tool.name} must use a string description.`,
      'invalid_tool_definition',
    );
  }
  if (
    tool.modeScopes !== undefined
    && (!Array.isArray(tool.modeScopes)
      || tool.modeScopes.some((mode) => typeof mode !== 'string' || mode.trim().length === 0))
  ) {
    throw new RuntimeProjectionError(
      `Runtime tool definition ${tool.name} must use non-empty string mode scopes.`,
      'invalid_tool_definition',
    );
  }
}

function freezeToolDefinition(tool: RuntimeToolDefinition): RuntimeToolDefinition {
  const modeScopes = tool.modeScopes === undefined
    ? undefined
    : Object.freeze([...tool.modeScopes]);
  const metadata = tool.metadata === undefined
    ? undefined
    : Object.freeze({ ...tool.metadata });

  return Object.freeze({
    ...tool,
    ...(modeScopes === undefined ? {} : { modeScopes }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

export function isRuntimeToolAvailableInMode(
  tool: RuntimeToolDefinition,
  mode?: RuntimeModeScope | null,
): boolean {
  if (mode == null) return true;

  const modeScopes = tool.modeScopes;
  if (!Array.isArray(modeScopes) || modeScopes.length === 0) {
    return mode !== 'explorer';
  }
  return modeScopes.includes(mode);
}

export function filterRuntimeToolsForMode(
  tools: readonly RuntimeToolDefinition[],
  mode?: RuntimeModeScope | null,
): readonly RuntimeToolDefinition[] {
  return tools.filter((tool) => isRuntimeToolAvailableInMode(tool, mode));
}

export function createRuntimeProjection(
  tools: readonly RuntimeToolDefinition[],
  options: CreateRuntimeProjectionOptions = {},
): RuntimeProjection {
  if (!Array.isArray(tools)) {
    throw new RuntimeProjectionError(
      'Runtime projection requires an array of tool definitions.',
      'invalid_tool_definition',
    );
  }

  const toolNames = new Set<string>();
  const normalizedTools = tools.map((tool) => {
    assertToolDefinition(tool);
    if (toolNames.has(tool.name)) {
      throw new RuntimeProjectionError(
        `Duplicate runtime tool definition: ${tool.name}`,
        'duplicate_tool_name',
      );
    }
    toolNames.add(tool.name);
    return freezeToolDefinition(tool);
  });
  const projectedTools = Object.freeze([
    ...filterRuntimeToolsForMode(normalizedTools, options.mode),
  ]);
  const metadata = options.metadata === undefined
    ? undefined
    : Object.freeze({ ...options.metadata });

  return Object.freeze({
    tools: projectedTools,
    ...(options.mode == null ? {} : { mode: options.mode }),
    createdAt: options.createdAt ?? options.now?.() ?? new Date().toISOString(),
    ...(metadata === undefined ? {} : { metadata }),
  });
}
