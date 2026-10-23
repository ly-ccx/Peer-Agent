/** A factual refusal layer; it never grants permission or changes acceptance. */
export interface CapabilityBlocker {
  readonly stage: 'projection' | 'role' | 'delegation_admission' | 'permission' | 'execution';
  readonly reason: string;
  readonly capabilityId?: string;
  readonly required?: readonly string[];
  readonly available?: readonly string[];
  readonly missing?: readonly string[];
  readonly criterionIds?: readonly string[];
  readonly alternatives?: readonly string[];
  readonly retryable: boolean;
  readonly userActionRequired: boolean;
}
export interface DelegationCapabilityAdmission {
  readonly required: readonly string[];
  readonly inventoryHash: string | null;
  readonly inventoryKnown: boolean;
  readonly requirementsDeclared: boolean;
  readonly checkedAt: string;
}
