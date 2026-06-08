import type {
  OpenClawAgentChannelListData,
  OpenClawAgentChannelSessionListData,
  OpenClawConversationEffectiveConfigData,
  OpenClawEffectiveAgentConfigData,
  OpenClawEnterResultData,
  OpenClawGovernanceCatalogData,
  OpenClawGovernanceListData,
  OpenClawSceneData,
  OpenClawSceneEventListData,
} from '@zeus-atlas/protocol';
import type { PreloadResult } from './apiResponse';

export type OpenClawGovernanceListResponse = PreloadResult<OpenClawGovernanceListData | readonly Record<string, unknown>[]>;

export interface OpenClawPreloadApi {
  readonly getOpenClawCurrentScene: () => PreloadResult<OpenClawSceneData>;
  readonly getOpenClawSceneEvents: (params?: {
    afterSeq?: number;
    limit?: number;
  }) => PreloadResult<OpenClawSceneEventListData>;
  readonly listOpenClawAgentChannels: (params: {
    agentId: number | string;
  }) => PreloadResult<OpenClawAgentChannelListData>;
  readonly listOpenClawAgentChannelSessions: (params: {
    agentId: number | string;
    channelType: string;
  }) => PreloadResult<OpenClawAgentChannelSessionListData>;
  readonly enterOpenClawAgentChat: (params: {
    agentId: number | string;
    [key: string]: unknown;
  }) => PreloadResult<OpenClawEnterResultData>;
  readonly enterOpenClawAgentChannelSession: (params: {
    agentId: number | string;
    channelType: string;
    sessionId: string;
  }) => PreloadResult<OpenClawEnterResultData>;
  readonly getOpenClawGovernanceCatalog: () => PreloadResult<OpenClawGovernanceCatalogData>;
  readonly listOpenClawIdentityProfiles: () => OpenClawGovernanceListResponse;
  readonly listOpenClawRolePostures: () => OpenClawGovernanceListResponse;
  readonly listOpenClawUnifiedServiceRefs: () => OpenClawGovernanceListResponse;
  readonly listOpenClawCapabilityProfiles: () => OpenClawGovernanceListResponse;
  readonly listOpenClawMemoryPacks: () => OpenClawGovernanceListResponse;
  readonly listOpenClawSeedMemoryPacks: () => OpenClawGovernanceListResponse;
  readonly listOpenClawMemoryBindingPolicies: () => OpenClawGovernanceListResponse;
  readonly listOpenClawMemoryWorkspaces: () => OpenClawGovernanceListResponse;
  readonly listOpenClawMemorySnapshots: () => OpenClawGovernanceListResponse;
  readonly listOpenClawMemoryTrainingRuns: () => OpenClawGovernanceListResponse;
  readonly listOpenClawTrainingScorecards: () => OpenClawGovernanceListResponse;
  readonly listOpenClawLearningSamples: () => OpenClawGovernanceListResponse;
  readonly listOpenClawMemoryCandidates: () => OpenClawGovernanceListResponse;
  readonly listOpenClawZeusBackflowExports: () => OpenClawGovernanceListResponse;
  readonly listOpenClawModelPolicies: () => OpenClawGovernanceListResponse;
  readonly listOpenClawCredentialProfiles: () => OpenClawGovernanceListResponse;
  readonly listOpenClawEvalSuites: () => OpenClawGovernanceListResponse;
  readonly listOpenClawSimulationEvals: () => OpenClawGovernanceListResponse;
  readonly listOpenClawCertifications: () => OpenClawGovernanceListResponse;
  readonly listOpenClawAgentReleases: () => OpenClawGovernanceListResponse;
  readonly listOpenClawReleaseChannels: () => OpenClawGovernanceListResponse;
  readonly listOpenClawOnDutyPolicies: () => OpenClawGovernanceListResponse;
  readonly listOpenClawSchedulePolicies: () => OpenClawGovernanceListResponse;
  readonly listOpenClawAlertPolicies: () => OpenClawGovernanceListResponse;
  readonly listOpenClawAlertIncidents: () => OpenClawGovernanceListResponse;
  readonly listOpenClawRemediationPolicies: () => OpenClawGovernanceListResponse;
  readonly listOpenClawRemediationActions: () => OpenClawGovernanceListResponse;
  readonly listOpenClawHumanTakeovers: () => OpenClawGovernanceListResponse;
  readonly listOpenClawUpgradeJobs: () => OpenClawGovernanceListResponse;
  readonly resolveOpenClawEffectiveAgentConfig: (params: {
    identityProfileId: string;
    agentReleaseId?: string;
    nodeId?: string;
    slotId?: string;
    taskDomain?: string;
    riskLevel?: string;
  }) => PreloadResult<OpenClawEffectiveAgentConfigData>;
  readonly resolveOpenClawConversationEffectiveConfig: (params: {
    conversationId?: number;
    conversationUuid?: string;
    taskDomain?: string;
    riskLevel?: string;
    nodeId?: string;
    slotId?: string;
  }) => PreloadResult<OpenClawConversationEffectiveConfigData>;
}
