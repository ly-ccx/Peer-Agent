export { validateState } from './index.js';
import type { InteractiveContent, InteractiveStateSchema, InteractiveStateValues } from '@peer-agent/protocol';
export function validateValues(values: InteractiveStateValues, schema: InteractiveStateSchema): InteractiveStateValues;
export function projectStateText(content: InteractiveContent, state: { readonly values: InteractiveStateValues; readonly inputDrafts?: Readonly<Record<string, string>> }, options?: { readonly fields?: readonly string[]; readonly isZh?: boolean }): string;
