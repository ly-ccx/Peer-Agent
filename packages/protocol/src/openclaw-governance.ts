export type OpenClawGovernanceRecord = Record<string, unknown>;

export interface OpenClawGovernanceListData {
  readonly items?: readonly OpenClawGovernanceRecord[];
  readonly list?: readonly OpenClawGovernanceRecord[];
  readonly total?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly [key: string]: unknown;
}

export interface OpenClawGovernanceCatalogData {
  readonly generatedAt?: number;
  readonly summary?: OpenClawGovernanceRecord;
  readonly rolePostures?: readonly OpenClawGovernanceRecord[];
  readonly identityProfiles?: readonly OpenClawGovernanceRecord[];
  readonly unifiedServiceRefs?: readonly OpenClawGovernanceRecord[];
  readonly capabilityProfiles?: readonly OpenClawGovernanceRecord[];
  readonly memoryPacks?: readonly OpenClawGovernanceRecord[];
  readonly seedMemoryPacks?: readonly OpenClawGovernanceRecord[];
  readonly memoryBindingPolicies?: readonly OpenClawGovernanceRecord[];
  readonly memoryWorkspaces?: readonly OpenClawGovernanceRecord[];
  readonly memorySnapshots?: readonly OpenClawGovernanceRecord[];
  readonly memoryTrainingRuns?: readonly OpenClawGovernanceRecord[];
  readonly trainingScorecards?: readonly OpenClawGovernanceRecord[];
  readonly learningSamples?: readonly OpenClawGovernanceRecord[];
  readonly memoryCandidates?: readonly OpenClawGovernanceRecord[];
  readonly zeusBackflowExports?: readonly OpenClawGovernanceRecord[];
  readonly modelPolicies?: readonly OpenClawGovernanceRecord[];
  readonly credentialProfiles?: readonly OpenClawGovernanceRecord[];
  readonly evalSuites?: readonly OpenClawGovernanceRecord[];
  readonly simulationEvals?: readonly OpenClawGovernanceRecord[];
  readonly certifications?: readonly OpenClawGovernanceRecord[];
  readonly agentReleases?: readonly OpenClawGovernanceRecord[];
  readonly onDutyPolicies?: readonly OpenClawGovernanceRecord[];
  readonly schedulePolicies?: readonly OpenClawGovernanceRecord[];
  readonly alertPolicies?: readonly OpenClawGovernanceRecord[];
  readonly alertIncidents?: readonly OpenClawGovernanceRecord[];
  readonly remediationPolicies?: readonly OpenClawGovernanceRecord[];
  readonly remediationActions?: readonly OpenClawGovernanceRecord[];
  readonly humanTakeovers?: readonly OpenClawGovernanceRecord[];
  readonly releaseChannels?: readonly OpenClawGovernanceRecord[];
  readonly upgradeJobs?: readonly OpenClawGovernanceRecord[];
  readonly [key: string]: unknown;
}

export interface OpenClawEffectiveAgentConfigData {
  readonly identityProfile?: OpenClawGovernanceRecord;
  readonly rolePosture?: OpenClawGovernanceRecord;
  readonly capabilityProfile?: OpenClawGovernanceRecord;
  readonly memorySnapshot?: OpenClawGovernanceRecord;
  readonly effectiveMemorySet?: OpenClawGovernanceRecord;
  readonly skillResolution?: readonly OpenClawGovernanceRecord[];
  readonly protocolResolution?: readonly OpenClawGovernanceRecord[];
  readonly modelResolution?: OpenClawGovernanceRecord;
  readonly credentialResolution?: OpenClawGovernanceRecord;
  readonly runtimeConstraints?: OpenClawGovernanceRecord;
  readonly [key: string]: unknown;
}

export interface OpenClawConversationEffectiveConfigData {
  readonly conversation?: OpenClawGovernanceRecord;
  readonly binding?: OpenClawGovernanceRecord;
  readonly effectiveAgentConfig?: OpenClawEffectiveAgentConfigData;
  readonly [key: string]: unknown;
}
