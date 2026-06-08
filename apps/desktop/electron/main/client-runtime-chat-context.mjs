function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Layer 2 预算常量。
// 对齐 Claude Code SkillTool 的 1% 上下文窗口 + 250 字符单条上限：
//   200k token × 4 char/token × 1% = 8000 字符。
const SKILLS_REMINDER_BUDGET_CHARS = 8000;
const SKILLS_REMINDER_DESC_MAX = 250;

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '\u2026';
}

function buildSkillEntryLine(skill, descMax = SKILLS_REMINDER_DESC_MAX) {
  const skillId = cleanString(skill?.skillId);
  if (!skillId) return null;
  const desc = cleanString(skill?.description);
  const when = cleanString(skill?.whenToUse);
  const combined = when ? (desc ? `${desc} - ${when}` : when) : desc;
  const truncated = truncate(combined, descMax);
  return truncated ? `- ${skillId}: ${truncated}` : `- ${skillId}`;
}

/**
 * Layer 2：生成 Skill 清单 system-reminder 纯文本。
 *
 * 预算策略（对齐 Claude Code）：
 *   1. 优先全量输出，累计 ≤ budgetChars 则直接返回。
 *   2. 超预算时按 enabled 优先（enabled !== false）不被截断，剩余预算给其余技能；
 *      仍超额时按等比例压缩 description，最小描述长度不低于 20，否则 names-only。
 *
 * 输出格式：
 *   - skillId: description - whenToUse
 *   - skillId（无描述时）
 */
export function formatSkillsAsReminderText(skillList, budgetChars = SKILLS_REMINDER_BUDGET_CHARS) {
  if (!Array.isArray(skillList) || skillList.length === 0) return '';
  const skills = skillList.filter((s) => isPlainObject(s) && cleanString(s.skillId));
  if (skills.length === 0) return '';

  // Pass 1：全量输出。
  const fullLines = skills.map((s) => buildSkillEntryLine(s)).filter(Boolean);
  const fullJoined = fullLines.join('\n');
  if (fullJoined.length <= budgetChars) return fullJoined;

  // Pass 2：enabled 保护 + 等比压缩。
  const enabledIdx = new Set();
  skills.forEach((s, i) => {
    if (s.enabled !== false) enabledIdx.add(i);
  });
  const enabledChars = fullLines.reduce(
    (sum, line, i) => (enabledIdx.has(i) ? sum + line.length + 1 : sum),
    0,
  );
  const restIdx = skills
    .map((_, i) => i)
    .filter((i) => !enabledIdx.has(i));

  if (restIdx.length === 0) {
    // 全是 enabled，仍超预算→ 按等比例压缩 description。
    return shrinkByDescription(skills, fullLines, budgetChars, new Set(skills.map((_, i) => i)));
  }

  const remainingBudget = Math.max(0, budgetChars - enabledChars);
  const restNameOverhead = restIdx.reduce(
    (sum, i) => sum + cleanString(skills[i].skillId).length + 4, // "- name: " 占位
    0,
  );
  const availableForDescs = remainingBudget - restNameOverhead;
  const maxDescLen = restIdx.length > 0 ? Math.floor(availableForDescs / restIdx.length) : 0;

  if (maxDescLen < 20) {
    // 极端情况：enabled 保留全量，其余 names-only。
    return skills
      .map((s, i) => (enabledIdx.has(i) ? fullLines[i] : `- ${cleanString(s.skillId)}`))
      .join('\n');
  }

  return shrinkByDescription(skills, fullLines, budgetChars, enabledIdx, maxDescLen);
}

function shrinkByDescription(skills, fullLines, budgetChars, protectedIdx, maxDescLen = SKILLS_REMINDER_DESC_MAX) {
  const lines = skills.map((s, i) => {
    if (protectedIdx.has(i)) return fullLines[i];
    return buildSkillEntryLine(s, maxDescLen);
  });
  const joined = lines.filter(Boolean).join('\n');
  // 如果仍超预算，从末尾递减，仅保留 names（protectedIdx 例外）。
  if (joined.length <= budgetChars) return joined;
  let totalChars = joined.length;
  for (let i = lines.length - 1; i >= 0 && totalChars > budgetChars; i--) {
    if (protectedIdx.has(i)) continue;
    const original = lines[i];
    if (!original) continue;
    const namesOnly = `- ${cleanString(skills[i].skillId)}`;
    totalChars -= original.length - namesOnly.length;
    lines[i] = namesOnly;
  }
  return lines.filter(Boolean).join('\n');
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return [];
  return capabilities
    .map((capability) => {
      if (cleanString(capability)) {
        return { capabilityId: cleanString(capability) };
      }
      if (!isPlainObject(capability)) return null;
      const capabilityId = cleanString(capability.capabilityId);
      if (!capabilityId) return null;
      return {
        capabilityId,
        ...(cleanString(capability.name) ? { name: capability.name } : {}),
        ...(cleanString(capability.description)
          ? { description: capability.description }
          : {}),
        ...(cleanString(capability.riskLevel)
          ? { riskLevel: capability.riskLevel }
          : {}),
        ...(cleanString(capability.dataLevel)
          ? { dataLevel: capability.dataLevel }
          : {}),
      };
    })
    .filter(Boolean);
}

function normalizeSkillsAsCapabilities(skills) {
  if (!Array.isArray(skills)) return [];
  return skills
    .map((skill) => {
      if (!isPlainObject(skill)) return null;
      const skillId = cleanString(skill.skillId);
      if (!skillId) return null;
      return {
        capabilityId: `local.skill.${skillId}`,
        ...(cleanString(skill.name) ? { name: skill.name } : {}),
        ...(cleanString(skill.description) ? { description: skill.description } : {}),
        // Layer 2 发现性提示：仅在非空时透传。
        ...(cleanString(skill.whenToUse) ? { whenToUse: skill.whenToUse } : {}),
        ...(cleanString(skill.dataLevel) ? { dataLevel: skill.dataLevel } : {}),
      };
    })
    .filter(Boolean);
}

/**
 * 将「已接入 MCP」列表展平为 capability 形态注入给模型。
 * 仅消费 mcpRegistry 持久化的 server.tools[]，不发起 tools/list 探活。
 * 命名空间：local.mcp.<mcpId>.<toolName>，与 local-mcp-provider 路由协议保持一致。
 */
export function normalizeMcpServersAsCapabilities(mcpServers) {
  if (!Array.isArray(mcpServers)) return [];
  const out = [];
  for (const server of mcpServers) {
    if (!isPlainObject(server)) continue;
    if (server.enabled === false) continue;
    const mcpId = cleanString(server.mcpId) || (Number.isFinite(server.mcpId) ? String(server.mcpId) : '');
    if (!mcpId) continue;
    const serverUrl = cleanString(server.serverUrl) || cleanString(server?.dingtalkActivation?.serverUrl);
    if (!serverUrl) continue;
    const tools = Array.isArray(server.tools) ? server.tools : [];
    if (tools.length === 0) continue;
    const serverName = cleanString(server.name);
    for (const tool of tools) {
      if (!isPlainObject(tool)) continue;
      const toolName = cleanString(tool.toolName) || cleanString(tool.name);
      if (!toolName) continue;
      const toolDesc = cleanString(tool.toolDesc) || cleanString(tool.description);
      const displayName = serverName ? `${serverName} / ${toolName}` : toolName;
      out.push({
        capabilityId: `local.mcp.${mcpId}.${toolName}`,
        name: displayName,
        ...(toolDesc ? { description: toolDesc } : {}),
      });
    }
  }
  return out;
}

function dedupCapabilitiesById(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const id = item?.capabilityId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

export function buildClientRuntimeChatContext({
  getSession = () => null,
  buildRuntimeProjection = () => null,
} = {}) {
  const rawSession = getSession?.();
  const rawProjection = buildRuntimeProjection?.();
  const session = isPlainObject(rawSession) ? rawSession : null;
  const projection = isPlainObject(rawProjection) ? rawProjection : null;
  const sessionId =
    cleanString(session?.sessionId) || cleanString(projection?.sessionId);
  const capabilities = normalizeCapabilities(projection?.capabilities);
  // 上游 buildRuntimeProjection 会把 mcp 合并进 projection.capabilities（供 guard 使用），
  // 这里拆出送入模型的顺序：base 非 mcp 能力 → skills → mcp。
  const baseNonMcp = capabilities.filter((c) => !c.capabilityId.startsWith('local.mcp.'));
  const baseMcp = capabilities.filter((c) => c.capabilityId.startsWith('local.mcp.'));
  const enabledSkills = (projection?.skills ?? []).filter((s) => s.enabled !== false);
  const skillCapabilities = normalizeSkillsAsCapabilities(enabledSkills);
  const mcpCapabilities = normalizeMcpServersAsCapabilities(projection?.mcpServers);
  // 按 capabilityId 去重，先到先得。
  const allCapabilities = dedupCapabilitiesById([
    ...baseNonMcp,
    ...skillCapabilities,
    ...baseMcp,
    ...mcpCapabilities,
  ]);
  // Layer 2：生成 system-reminder 纯文本，供云端拼接进每轮 user message 的 reminder 段。
  const skillsReminderText = formatSkillsAsReminderText(enabledSkills);

  if (!sessionId && allCapabilities.length === 0 && !skillsReminderText) {
    return {};
  }

  const clientRuntime = {
    ...(sessionId ? { sessionId } : {}),
    ...(allCapabilities.length > 0 ? { capabilities: allCapabilities } : {}),
    ...(skillsReminderText ? { skillsReminderText } : {}),
    ...(cleanString(projection?.accessLevel)
      ? { accessLevel: projection.accessLevel }
      : {}),
    ...(cleanString(projection?.createdAt)
      ? { createdAt: projection.createdAt }
      : {}),
  };

  return {
    ...(sessionId ? { sessionId } : {}),
    sourceMetadata: {
      clientRuntimeSource: 'zeus_atlas_desktop',
      ...(sessionId ? { clientRuntimeSessionId: sessionId } : {}),
      ...(allCapabilities.length > 0
        ? { clientRuntimeCapabilities: allCapabilities }
        : {}),
      clientRuntime,
    },
  };
}

export function mergeClientRuntimeSourceMetadata(
  streamParams = {},
  runtimeContext = {},
) {
  const currentSourceMetadata = isPlainObject(streamParams.sourceMetadata)
    ? streamParams.sourceMetadata
    : {};
  const runtimeSourceMetadata = isPlainObject(runtimeContext.sourceMetadata)
    ? runtimeContext.sourceMetadata
    : {};
  const sourceMetadata = {
    ...currentSourceMetadata,
    ...runtimeSourceMetadata,
  };

  return Object.keys(sourceMetadata).length > 0 ? sourceMetadata : undefined;
}
