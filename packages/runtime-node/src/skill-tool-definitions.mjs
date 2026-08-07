const SKILL_PREFIX = 'local.skill.';
const SKILL_MODE_SCOPES = Object.freeze(['chat', 'plan', 'goal']);

function normalizeInputSchema(schema) {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) return schema;
  return {
    type: 'object',
    properties: {
      userMessage: {
        type: 'string',
        description: 'The user request that triggered this skill.',
      },
    },
    additionalProperties: true,
  };
}

function buildSkillPrompt(skill) {
  const description = typeof skill?.description === 'string' ? skill.description.trim() : '';
  const whenToUse = typeof skill?.whenToUse === 'string' ? skill.whenToUse.trim() : '';
  const joined = [description, whenToUse].filter(Boolean).join('\n');
  if (joined) return joined;
  const skillId = skill?.skillId || skill?.name || 'skill';
  return `Load the local skill ${skill?.name || skillId} instructions.`;
}

/**
 * Project one enabled skill into a Desktop Runtime Tool Registry definition.
 * Model-visible name follows the TUI/MCP-safe pattern skill__<id>.
 * Executor capabilityId stays local.skill.<id> for LocalSkillProvider routing.
 */
export function createSkillToolDefinition(skill) {
  if (!skill || typeof skill !== 'object') return null;
  const skillId = typeof skill.skillId === 'string' ? skill.skillId.trim() : '';
  if (!skillId) return null;
  if (skill.enabled === false) return null;

  const safeSkillId = skillId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const capabilityId = `${SKILL_PREFIX}${skillId}`;
  return {
    name: `skill__${safeSkillId}`,
    capabilityId,
    availableInModes: [...SKILL_MODE_SCOPES],
    prompt: () => buildSkillPrompt(skill),
    inputSchema: normalizeInputSchema(skill.inputSchema),
    runtime: {
      executor: 'local-tool-host',
      executorCapabilityId: capabilityId,
    },
    permissionPolicy: skill.permissionPolicy ?? {
      kind: 'skill',
      required: false,
    },
    source: 'skill',
    skillId,
    skillName: skill.name || skillId,
  };
}

/**
 * Project enabled skills from a SkillStore (or listSkills()-compatible store)
 * into Runtime Tool Registry definitions.
 */
export function createSkillToolDefinitionsFromStore(skillStore) {
  if (!skillStore || typeof skillStore.listSkills !== 'function') return [];
  const listed = skillStore.listSkills();
  if (!Array.isArray(listed)) return [];
  return listed
    .map(createSkillToolDefinition)
    .filter(Boolean);
}

export { SKILL_PREFIX };
