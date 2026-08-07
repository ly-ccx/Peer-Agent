/**
 * Skill 工具展示识别。
 *
 * Skill 以 capabilityId `local.skill.<skillId>` 进入 Runtime Projection / 工具流。
 * 渲染层用此前缀把 Skill 从普通工具（read_file / bash 等）中分出来，
 * 再取出技能名（优先 displayName，否则 skillId）给胶囊展示。
 */

export const SKILL_CAPABILITY_PREFIX = 'local.skill.';

export type SkillToolView = {
  readonly skillId: string;
  readonly skillName: string;
  readonly capabilityId: string;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function isSkillCapabilityId(value: unknown): value is string {
  const text = asNonEmptyString(value);
  return Boolean(text && text.startsWith(SKILL_CAPABILITY_PREFIX));
}

export function extractSkillIdFromCapabilityId(capabilityId: string): string {
  if (!isSkillCapabilityId(capabilityId)) return capabilityId.trim();
  return capabilityId.slice(SKILL_CAPABILITY_PREFIX.length).trim() || capabilityId.trim();
}

/**
 * 从工具卡/时间线字段识别 Skill。
 * 识别顺序：tool → capabilityId → displayName（后两者兼容历史/协议差异）。
 * 技能名：displayName 若不是 capabilityId 本身则优先；否则回退 skillId。
 */
export function parseSkillToolView(input: {
  readonly tool?: string | null;
  readonly capabilityId?: string | null;
  readonly displayName?: string | null;
}): SkillToolView | null {
  const tool = asNonEmptyString(input.tool);
  const capabilityId = asNonEmptyString(input.capabilityId);
  const displayName = asNonEmptyString(input.displayName);

  const matchedCapability =
    (tool && isSkillCapabilityId(tool) ? tool : null)
    ?? (capabilityId && isSkillCapabilityId(capabilityId) ? capabilityId : null)
    ?? (displayName && isSkillCapabilityId(displayName) ? displayName : null);

  if (!matchedCapability) return null;

  const skillId = extractSkillIdFromCapabilityId(matchedCapability);
  const skillName =
    displayName && !isSkillCapabilityId(displayName)
      ? displayName
      : skillId;

  return {
    skillId,
    skillName,
    capabilityId: matchedCapability,
  };
}
