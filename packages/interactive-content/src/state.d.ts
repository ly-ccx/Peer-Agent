export { validateState } from './index.js';
import type { InteractiveStateSchema, InteractiveStateValues } from '@peer-agent/protocol';
export function validateValues(values: InteractiveStateValues, schema: InteractiveStateSchema): InteractiveStateValues;
