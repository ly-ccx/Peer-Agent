export interface LocalToolContract<
  TToolName extends string = string,
  TCapabilityId extends string = string,
> {
  readonly toolName: TToolName;
  readonly capabilityId: TCapabilityId;
}

function defineToolContract<
  const TToolName extends string,
  const TCapabilityId extends string,
>(
  toolName: TToolName,
  capabilityId: TCapabilityId,
): Readonly<LocalToolContract<TToolName, TCapabilityId>> {
  return Object.freeze({ toolName, capabilityId });
}

/**
 * Canonical model-visible contracts shared by Desktop and CLI/TUI.
 *
 * Provider implementations and input schemas remain owned by their capability
 * modules. This registry only defines the stable public name/ID boundary.
 */
export const SHARED_LOCAL_TOOL_CONTRACTS = Object.freeze({
  readFile: defineToolContract('read_file', 'local.file.read'),
  listFiles: defineToolContract('list_files', 'local.file.list'),
  searchFiles: defineToolContract('search_files', 'local.file.search'),
  editFile: defineToolContract('edit_file', 'local.file.edit'),
  writeFile: defineToolContract('write_file', 'local.file.write'),
  shellExec: defineToolContract('bash', 'local.shell.exec'),
  shellStop: defineToolContract('shell_stop', 'local.shell.stop'),
  batchSearch: defineToolContract('batch_search', 'local.search.aggregate'),
  webFetch: defineToolContract('web_fetch', 'local.web.fetch'),
  requestUserInput: defineToolContract(
    'request_user_input',
    'local.interaction.request_user_input',
  ),
  goalCreatePlan: defineToolContract('goal_create_plan', 'local.goal.create_plan'),
  goalUpdateTask: defineToolContract('goal_update_task', 'local.goal.update_task'),
  goalGetPlan: defineToolContract('goal_get_plan', 'local.goal.get_plan'),
  requestExplorer: defineToolContract('request_explorer', 'local.goal.explore'),
});

export type SharedLocalToolContractKey = keyof typeof SHARED_LOCAL_TOOL_CONTRACTS;
export type SharedLocalToolName =
  (typeof SHARED_LOCAL_TOOL_CONTRACTS)[SharedLocalToolContractKey]['toolName'];
export type SharedLocalCapabilityId =
  (typeof SHARED_LOCAL_TOOL_CONTRACTS)[SharedLocalToolContractKey]['capabilityId'];

export const SHARED_LOCAL_TOOL_CONTRACT_LIST = Object.freeze(
  Object.values(SHARED_LOCAL_TOOL_CONTRACTS),
);

/**
 * Tool calls that may run concurrently inside one ModelStep.
 * Writes, shell, MCP, and unknown capabilities stay serial.
 */
export const PARALLEL_SAFE_LOCAL_CAPABILITY_IDS = Object.freeze([
  SHARED_LOCAL_TOOL_CONTRACTS.readFile.capabilityId,
  SHARED_LOCAL_TOOL_CONTRACTS.listFiles.capabilityId,
  SHARED_LOCAL_TOOL_CONTRACTS.searchFiles.capabilityId,
] as const);

const PARALLEL_SAFE_LOCAL_CAPABILITY_ID_SET: ReadonlySet<string> = new Set(
  PARALLEL_SAFE_LOCAL_CAPABILITY_IDS,
);

export function isParallelSafeLocalToolBatch(
  calls: readonly { readonly capabilityId?: string }[],
): boolean {
  if (calls.length <= 1) return false;
  return calls.every((call) => (
    typeof call.capabilityId === 'string'
    && PARALLEL_SAFE_LOCAL_CAPABILITY_ID_SET.has(call.capabilityId)
  ));
}

/**
 * Explicit Desktop-only capabilities. Parity assertions must exclude exactly
 * these contracts instead of ignoring arbitrary browser-prefixed additions.
 */
export const DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS = Object.freeze({
  browserOpenPanel: defineToolContract('browser_open_panel', 'local.web.control.openPanel'),
  browserNavigate: defineToolContract('browser_navigate', 'local.web.control.navigate'),
  browserClick: defineToolContract('browser_click', 'local.web.control.click'),
  browserType: defineToolContract('browser_type', 'local.web.control.type'),
  browserScreenshot: defineToolContract(
    'browser_screenshot',
    'local.web.control.screenshot',
  ),
  browserReadDom: defineToolContract('browser_read_dom', 'local.web.control.readDom'),
  browserHover: defineToolContract('browser_hover', 'local.web.control.hover'),
  browserScroll: defineToolContract('browser_scroll', 'local.web.control.scroll'),
  browserKey: defineToolContract('browser_key', 'local.web.control.key'),
  browserDrag: defineToolContract('browser_drag', 'local.web.control.drag'),
});

export const DESKTOP_ONLY_LOCAL_TOOL_CONTRACT_LIST = Object.freeze(
  Object.values(DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS),
);

/**
 * Read-time/inbound compatibility only. New Runtime Projections must never
 * expose these legacy capability IDs.
 */
export const LEGACY_LOCAL_CAPABILITY_ID_ALIASES = Object.freeze({
  'local.goal.create': SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.capabilityId,
  'local.goal.update': SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.capabilityId,
  'local.goal.read': SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.capabilityId,
  'local.search.content': SHARED_LOCAL_TOOL_CONTRACTS.searchFiles.capabilityId,
});

/** Historical model-tool names accepted while replaying old turns. */
export const LEGACY_LOCAL_MODEL_TOOL_NAME_ALIASES = Object.freeze({
  local_shell_exec: SHARED_LOCAL_TOOL_CONTRACTS.shellExec.toolName,
});

export function canonicalizeLocalCapabilityId(capabilityId: string): string {
  return LEGACY_LOCAL_CAPABILITY_ID_ALIASES[
    capabilityId as keyof typeof LEGACY_LOCAL_CAPABILITY_ID_ALIASES
  ] ?? capabilityId;
}

export function canonicalizeLocalModelToolName(toolName: string): string {
  return LEGACY_LOCAL_MODEL_TOOL_NAME_ALIASES[
    toolName as keyof typeof LEGACY_LOCAL_MODEL_TOOL_NAME_ALIASES
  ] ?? toolName;
}

export function isSharedLocalCapabilityId(
  capabilityId: string,
): capabilityId is SharedLocalCapabilityId {
  return SHARED_LOCAL_TOOL_CONTRACT_LIST.some(
    (contract) => contract.capabilityId === capabilityId,
  );
}

export function isSharedLocalToolName(toolName: string): toolName is SharedLocalToolName {
  return SHARED_LOCAL_TOOL_CONTRACT_LIST.some(
    (contract) => contract.toolName === toolName,
  );
}
