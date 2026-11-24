import {
  hasBotCapabilityOverrides,
  toggleBotMcpOverride,
  toggleBotSkillOverride,
  type BotCapabilityPolicy,
  type BotProfile,
  type CapabilityManifest,
  type LocalMcpServerView,
  type SkillSummary,
} from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import {
  mergeBotMcps,
  mergeBotSkills,
  summarizeBuiltinCapabilities,
  type BotBuiltinCapabilityItem,
  type BotMountedMcpItem,
  type BotMountedSkillItem,
} from './botCapabilitiesState';

export type {
  BotBuiltinCapabilityItem,
  BotMountedMcpItem,
  BotMountedMcpTool,
  BotMountedSkillItem,
} from './botCapabilitiesState';
export { mergeBotMcps, mergeBotSkills, summarizeBuiltinCapabilities } from './botCapabilitiesState';

export interface BotCapabilitiesState {
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string;
  readonly skills: readonly BotMountedSkillItem[];
  readonly mcps: readonly BotMountedMcpItem[];
  readonly builtins: readonly BotBuiltinCapabilityItem[];
  readonly mountedSkillCount: number;
  readonly mountedMcpCount: number;
  readonly mountedMcpToolCount: number;
  readonly mountedTotalCount: number;
  readonly hasOverrides: boolean;
  readonly refresh: () => Promise<void>;
  readonly toggleSkill: (skillId: string, nextEnabled: boolean) => Promise<void>;
  readonly toggleMcp: (mcpId: string, nextEnabled: boolean) => Promise<void>;
  readonly resetOverrides: () => Promise<void>;
}

export function useBotCapabilities(
  workspaceId: string | null,
  workspacePath: string,
  profile: BotProfile | null,
  onProfile: (profile: BotProfile) => void,
): BotCapabilitiesState {
  const [rawSkills, setRawSkills] = useState<readonly SkillSummary[]>([]);
  const [rawMcps, setRawMcps] = useState<readonly LocalMcpServerView[]>([]);
  const [rawBuiltins, setRawBuiltins] = useState<readonly CapabilityManifest[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const requestSeqRef = useRef(0);
  const policyRef = useRef<BotCapabilityPolicy | null | undefined>(profile?.capabilityPolicy);
  policyRef.current = profile?.capabilityPolicy;

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setRawSkills([]);
      setRawMcps([]);
      setRawBuiltins([]);
      setLoading(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const [skillsRes, mcpsRes, capsRes] = await Promise.all([
        clientApi.listSkills(workspacePath ? [workspacePath] : []).catch(() => [] as SkillSummary[]),
        clientApi.mcpListInstalled().catch(() => [] as LocalMcpServerView[]),
        clientApi.listCapabilities().catch(() => [] as CapabilityManifest[]),
      ]);
      if (seq !== requestSeqRef.current) return;
      setRawSkills(Array.isArray(skillsRes) ? skillsRes : []);
      setRawMcps(Array.isArray(mcpsRes) ? mcpsRes : []);
      setRawBuiltins(Array.isArray(capsRes) ? capsRes : []);
      setError('');
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [workspaceId, workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!workspaceId) return undefined;
    return clientApi.onProjectAgentChanged((event) => {
      if (event.workspaceIds?.includes(workspaceId)) {
        void refresh();
      }
    });
  }, [workspaceId, refresh]);

  const policy = profile?.capabilityPolicy ?? null;
  const skills = useMemo(() => mergeBotSkills(rawSkills, policy), [rawSkills, policy]);
  const mcps = useMemo(() => mergeBotMcps(rawMcps, policy), [rawMcps, policy]);
  const builtins = useMemo(() => summarizeBuiltinCapabilities(rawBuiltins), [rawBuiltins]);

  const mountedSkillCount = useMemo(
    () => skills.filter((item) => item.effectiveEnabled).length,
    [skills],
  );
  const mountedMcpCount = useMemo(
    () => mcps.filter((item) => item.effectiveEnabled && item.trusted && item.healthStatus !== 'failed').length,
    [mcps],
  );
  const mountedMcpToolCount = useMemo(
    () => mcps
      .filter((item) => item.effectiveEnabled && item.trusted && item.healthStatus !== 'failed')
      .reduce((sum, item) => sum + item.visibleToolsCount, 0),
    [mcps],
  );

  const persistPolicy = useCallback(async (nextPolicy: BotCapabilityPolicy | null) => {
    if (!workspaceId) return;
    setSaving(true);
    setError('');
    try {
      const result = await clientApi.projectAgentUpdateProfile({
        workspaceId,
        capabilityPolicy: nextPolicy,
      });
      if (!result?.ok || !result.profile) {
        setError(result?.code || 'SAVE_FAILED');
        return;
      }
      onProfile(result.profile);
    } catch {
      setError('SAVE_FAILED');
    } finally {
      setSaving(false);
    }
  }, [workspaceId, onProfile]);

  const toggleSkill = useCallback(async (skillId: string, nextEnabled: boolean) => {
    const target = skills.find((item) => item.skillId === skillId);
    if (!target) return;
    const nextPolicy = toggleBotSkillOverride(policyRef.current, skillId, target.defaultEnabled, nextEnabled);
    await persistPolicy(nextPolicy);
  }, [skills, persistPolicy]);

  const toggleMcp = useCallback(async (mcpId: string, nextEnabled: boolean) => {
    const target = mcps.find((item) => item.id === mcpId);
    if (!target) return;
    const nextPolicy = toggleBotMcpOverride(policyRef.current, mcpId, target.defaultEnabled, nextEnabled);
    await persistPolicy(nextPolicy);
  }, [mcps, persistPolicy]);

  const resetOverrides = useCallback(async () => {
    await persistPolicy(null);
  }, [persistPolicy]);

  return {
    loading,
    saving,
    error,
    skills,
    mcps,
    builtins,
    mountedSkillCount,
    mountedMcpCount,
    mountedMcpToolCount,
    mountedTotalCount: mountedSkillCount + mountedMcpCount,
    hasOverrides: hasBotCapabilityOverrides(policy),
    refresh,
    toggleSkill,
    toggleMcp,
    resetOverrides,
  };
}
