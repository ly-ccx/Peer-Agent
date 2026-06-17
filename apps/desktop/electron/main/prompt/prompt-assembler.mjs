import { createHash } from 'node:crypto';
import { joinPromptSections } from './rendering.mjs';
import { createPromptSourceRegistry } from './prompt-source-registry.mjs';
import { createAttachmentPromptSource } from './sources/attachment-source.mjs';
import { createContinuityPromptSource } from './sources/continuity-source.mjs';
import { createContextExtensionPromptSource } from './sources/context-extension-source.mjs';
import { createGoalPlanPromptSource } from './sources/goal-plan-source.mjs';
import { createCorePromptSource } from './sources/core-source.mjs';
import { createProviderPromptSource } from './sources/provider-source.mjs';
import { createProjectInstructionsPromptSource } from './sources/project-instructions-source.mjs';
import { createRuntimePromptSource } from './sources/runtime-source.mjs';
import { createRuntimeReminderPromptSource } from './sources/runtime-reminder-source.mjs';

const LAYER_ORDER = new Map([
  ['L0_CORE', 0],
  ['L1_AGENT', 1],
  ['L2_RUNTIME', 2],
  ['L3_INSTRUCTIONS', 3],
  ['L4_CAPABILITIES', 4],
  ['L5_TOOL_RULES', 5],
  ['L6_MODE_REMINDER', 6],
  ['L7_CONTINUITY', 7],
]);

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function layerRank(layer) {
  return LAYER_ORDER.get(layer) ?? 999;
}

function normalizeSection(section, source) {
  const normalized = {
    id: section.id,
    layer: section.layer ?? source.layer,
    priority: Number.isFinite(section.priority) ? section.priority : (source.priority ?? 0),
    title: section.title ?? section.id,
    content: String(section.content ?? ''),
    source: section.source ?? { id: source.id },
    trust: section.trust ?? source.trust ?? 'runtime',
  };
  return {
    ...normalized,
    checksum: section.checksum ?? sha256([
      normalized.id,
      normalized.layer,
      normalized.priority,
      normalized.title,
      normalized.content,
      normalized.trust,
    ].join('\n')),
  };
}

function sortSections(sections) {
  return [...sections].sort((a, b) => {
    const layerDiff = layerRank(a.layer) - layerRank(b.layer);
    if (layerDiff !== 0) return layerDiff;
    const priorityDiff = a.priority - b.priority;
    if (priorityDiff !== 0) return priorityDiff;
    return a.id.localeCompare(b.id);
  });
}

export function createDefaultPromptSourceRegistry() {
  return createPromptSourceRegistry({
    sources: [
      createCorePromptSource(),
      createRuntimePromptSource(),
      createProviderPromptSource(),
      createAttachmentPromptSource(),
      createProjectInstructionsPromptSource(),
      createContextExtensionPromptSource(),
      createRuntimeReminderPromptSource(),
      createGoalPlanPromptSource(),
      createContinuityPromptSource(),
    ],
  });
}

export function renderSystemContext(context) {
  return joinPromptSections((context?.sections ?? []).map((section) => section.content));
}

export function assembleSystemContext(input = {}, options = {}) {
  const registry = options.registry ?? createDefaultPromptSourceRegistry();
  const sections = [];

  for (const source of registry.listSources()) {
    const observation = source.observe(input);
    const rendered = source.render(observation, input) ?? [];
    for (const section of rendered) {
      if (!section?.content) continue;
      sections.push(normalizeSection(section, source));
    }
  }

  const sortedSections = sortSections(sections);
  const rendered = renderSystemContext({ sections: sortedSections });
  const renderedHash = sha256(rendered);

  return {
    version: 1,
    sections: sortedSections,
    rendered,
    snapshot: {
      id: `prompt-${renderedHash.slice(0, 16)}`,
      createdAt: new Date().toISOString(),
      conversationId: input.conversationId ?? null,
      workspacePath: input.workspacePath ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      mode: input.mode ?? 'chat',
      sectionRefs: sortedSections.map((section) => ({
        id: section.id,
        layer: section.layer,
        checksum: section.checksum,
        source: section.source,
      })),
      renderedHash,
    },
  };
}
