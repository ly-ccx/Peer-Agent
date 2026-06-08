import type { OpenClawGovernanceListData } from '@zeus-atlas/protocol';
import { clientApi } from '../../clientApi';
import { unwrap } from './apiResponse';
import {
  normalizeOpenClawGovernanceListData,
  unwrapOpenClawGovernanceList,
} from './chatNormalizers';

export const openClawGovernanceChatClient = {
  async listOpenClawIdentityProfiles(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawIdentityProfiles(), '加载 Identity Profile 失败'));
  },
  async listOpenClawRolePostures(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawRolePostures(), '加载 Role Posture 失败'));
  },
  async listOpenClawUnifiedServiceRefs(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawUnifiedServiceRefs(), '加载 Unified Service Ref 失败');
  },
  async listOpenClawCapabilityProfiles(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawCapabilityProfiles(), '加载 Capability Profile 失败'));
  },
  async listOpenClawMemoryPacks(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawMemoryPacks(), '加载 Memory Pack 失败'));
  },
  async listOpenClawSeedMemoryPacks(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawSeedMemoryPacks(), '加载 Seed Memory Pack 失败');
  },
  async listOpenClawMemoryBindingPolicies(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawMemoryBindingPolicies(), '加载 Memory Binding Policy 失败');
  },
  async listOpenClawMemoryWorkspaces(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawMemoryWorkspaces(), '加载 Memory Workspace 失败');
  },
  async listOpenClawMemorySnapshots(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawMemorySnapshots(), '加载 Memory Snapshot 失败');
  },
  async listOpenClawMemoryTrainingRuns(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawMemoryTrainingRuns(), '加载 Memory Training Run 失败'));
  },
  async listOpenClawTrainingScorecards(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawTrainingScorecards(), '加载 Training Scorecard 失败');
  },
  async listOpenClawLearningSamples(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawLearningSamples(), '加载 Learning Sample 失败');
  },
  async listOpenClawMemoryCandidates(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawMemoryCandidates(), '加载 Memory Candidate 失败'));
  },
  async listOpenClawZeusBackflowExports(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawZeusBackflowExports(), '加载 Zeus Backflow Export 失败'));
  },
  async listOpenClawModelPolicies(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawModelPolicies(), '加载 Model Policy 失败');
  },
  async listOpenClawCredentialProfiles(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawCredentialProfiles(), '加载 Credential Profile 失败');
  },
  async listOpenClawEvalSuites(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawEvalSuites(), '加载 Eval Suite 失败');
  },
  async listOpenClawSimulationEvals(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawSimulationEvals(), '加载 Simulation Eval 失败'));
  },
  async listOpenClawCertifications(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawCertifications(), '加载 Certification 失败'));
  },
  async listOpenClawAgentReleases(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawAgentReleases(), '加载 Agent Release 失败'));
  },
  async listOpenClawReleaseChannels(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawReleaseChannels(), '加载 Release Channel 失败'));
  },
  async listOpenClawOnDutyPolicies(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawOnDutyPolicies(), '加载 On Duty Policy 失败');
  },
  async listOpenClawSchedulePolicies(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawSchedulePolicies(), '加载 Schedule Policy 失败');
  },
  async listOpenClawAlertPolicies(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawAlertPolicies(), '加载 Alert Policy 失败');
  },
  async listOpenClawAlertIncidents(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawAlertIncidents(), '加载 Alert Incident 失败'));
  },
  async listOpenClawRemediationPolicies(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawRemediationPolicies(), '加载 Remediation Policy 失败');
  },
  async listOpenClawRemediationActions(): Promise<OpenClawGovernanceListData> {
    return normalizeOpenClawGovernanceListData(unwrap(await clientApi.chat.listOpenClawRemediationActions(), '加载 Remediation Action 失败'));
  },
  async listOpenClawHumanTakeovers(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawHumanTakeovers(), '加载 Human Takeover 失败');
  },
  async listOpenClawUpgradeJobs(): Promise<OpenClawGovernanceListData> {
    return unwrapOpenClawGovernanceList(clientApi.chat.listOpenClawUpgradeJobs(), '加载 Upgrade Job 失败');
  },
};
