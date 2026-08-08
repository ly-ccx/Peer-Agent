/**
 * Skill 工具展示识别。
 *
 * 运行时有两套标识：
 * - 模型可见名：`skill__<skillId>`（TUI/MCP 安全名，聊天流里 tool 字段常见这个）
 * - 执行 capabilityId：`local.skill.<skillId>`（LocalSkillProvider 路由用）
 *
 * 渲染层必须同时识别两者，才能把 Skill 从普通工具卡分出来做成胶囊。
 */

export const SKILL_CAPABILITY_PREFIX = 'local.skill.';
export const SKILL_MODEL_NAME_PREFIX = 'skill__';

export type SkillToolView = {
  readonly skillId: string;
  readonly skillName: string;
  readonly capabilityId: string;
  readonly modelName: string;
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

export function isSkillModelName(value: unknown): value is string {
  const text = asNonEmptyString(value);
  return Boolean(text && text.startsWith(SKILL_MODEL_NAME_PREFIX));
}

export function extractSkillIdFromCapabilityId(capabilityId: string): string {
  if (!capabilityId.trim().startsWith(SKILL_CAPABILITY_PREFIX)) return capabilityId.trim();
  return capabilityId.slice(SKILL_CAPABILITY_PREFIX.length).trim() || capabilityId.trim();
}

export function extractSkillIdFromModelName(modelName: string): string {
  if (!modelName.trim().startsWith(SKILL_MODEL_NAME_PREFIX)) return modelName.trim();
  return modelName.slice(SKILL_MODEL_NAME_PREFIX.length).trim() || modelName.trim();
}

function looksLikeRawSkillId(value: string): boolean {
  return isSkillCapabilityId(value) || isSkillModelName(value);
}

/**
 * 从工具卡/时间线字段识别 Skill。
 * 识别顺序：tool → capabilityId → displayName。
 * 技能名：displayName 若不是 raw skill id/name 则优先；否则回退 skillId。
 */
export function parseSkillToolView(input: {
  readonly tool?: string | null;
  readonly capabilityId?: string | null;
  readonly displayName?: string | null;
}): SkillToolView | null {
  const tool = asNonEmptyString(input.tool);
  const capabilityId = asNonEmptyString(input.capabilityId);
  const displayName = asNonEmptyString(input.displayName);

  let skillId: string | null = null;
  let matchedCapability: string | null = null;
  let modelName: string | null = null;

  const candidates = [tool, capabilityId, displayName];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isSkillCapabilityId(candidate)) {
      skillId = extractSkillIdFromCapabilityId(candidate);
      matchedCapability = candidate;
      modelName = `${SKILL_MODEL_NAME_PREFIX}${skillId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      break;
    }
    if (isSkillModelName(candidate)) {
      skillId = extractSkillIdFromModelName(candidate);
      modelName = candidate;
      matchedCapability = `${SKILL_CAPABILITY_PREFIX}${skillId}`;
      break;
    }
  }

  if (!skillId || !matchedCapability || !modelName) return null;

  const skillName =
    displayName && !looksLikeRawSkillId(displayName)
      ? displayName
      : skillId;

  return {
    skillId,
    skillName,
    capabilityId: matchedCapability,
    modelName,
  };
}
