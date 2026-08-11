const ACTIVE_STATUSES = new Set(['collecting', 'proposed', 'creating']);
const TERMINAL_STATUSES = new Set(['created', 'cancelled', 'failed']);

function normalizeMode(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'chat';
}

function normalizeContext(value) {
  if (!value || typeof value !== 'object' || value.kind !== 'automation_create') return null;
  const status = typeof value.status === 'string' ? value.status : null;
  const source = typeof value.source === 'string' ? value.source : null;
  const proposal = value.activeProposal && typeof value.activeProposal === 'object'
    ? value.activeProposal
    : null;
  return Object.freeze({
    source,
    status,
    proposalId: typeof proposal?.proposalId === 'string' ? proposal.proposalId : null,
    proposalStatus: typeof proposal?.status === 'string' ? proposal.status : null,
    hasActiveProposal: Boolean(proposal),
    isActive: ACTIVE_STATUSES.has(status),
    isTerminal: TERMINAL_STATUSES.has(status),
  });
}

function renderPolicy() {
  return [
    'Automation task intent policy (chat mode).',
    '',
    'Use the governed `propose_automation_task` tool only for delegated work that the user wants run later, on a schedule, or repeatedly.',
    '- High confidence: the user clearly requests future or repeating execution and the task plus schedule are concrete. Call the proposal tool directly.',
    '- Medium confidence: automation is likely, but the task or schedule is materially ambiguous. Ask one focused clarification before proposing.',
    '- Low confidence: the user is discussing time, routines, or future work without delegating execution. Continue normal chat and do not surface automation UI.',
    '',
    'The model supplies task semantics and schedule parameters only. Never ask the user for a workspace path or timezone; the local host binds the conversation workspace, system timezone, and safe grant defaults.',
    '`propose_automation_task` only creates or revises a proposal card. It never creates an Automation. Creation requires the user’s explicit confirmation on that card and a structured creation receipt. Never claim creation from assistant text or from a proposal tool result.',
  ].join('\n');
}

function renderState(observation) {
  const context = observation.context;
  if (!context) return null;

  const lines = [
    'Automation creation conversation state (runtime fact).',
    'This section reports trusted lifecycle metadata only; it does not authorize tool execution or replace a proposal-card action.',
    `Source: ${context.source ?? 'unknown'}`,
    `Status: ${context.status ?? 'unknown'}`,
  ];

  if (context.proposalId) lines.push(`Active proposal id: ${context.proposalId}`);
  if (context.proposalStatus) lines.push(`Active proposal status: ${context.proposalStatus}`);

  if (context.source === 'automation_center' && context.status === 'collecting') {
    lines.push(
      'This is a strong Automation Center entry. The user has already chosen to create an automation: collect only missing task or schedule details, then call `propose_automation_task` when concrete. Do not ask whether they want automation.',
    );
  } else if (context.status === 'proposed') {
    lines.push(
      'A proposal card is already awaiting user action. Do not emit a duplicate. If the user asks to change it, call `propose_automation_task` with the complete revised task and schedule; otherwise wait for explicit confirmation or cancellation on the card.',
    );
  } else if (context.status === 'creating') {
    lines.push('Confirmation is being processed. Do not submit another proposal or claim success before a structured receipt exists.');
  } else if (context.status === 'created') {
    lines.push('The confirmed proposal has already created an Automation. Do not propose it again unless the user explicitly starts a new automation request.');
  } else if (context.status === 'cancelled') {
    lines.push('The proposal was cancelled. Do not recreate the same proposal unless the user explicitly asks to resume, revise, or start a new automation request.');
  } else if (context.status === 'failed') {
    lines.push('The proposal or confirmed creation failed. Do not claim success or retry unprompted; respond to an explicit retry or revision request through the governed proposal flow.');
  }

  return lines.join('\n');
}

export function createAutomationIntentPromptSource() {
  return {
    id: 'automation.intent-policy',
    layer: 'L5_TOOL_RULES',
    priority: 20,
    trust: 'runtime',
    observe(input = {}) {
      const mode = normalizeMode(input.mode);
      return Object.freeze({
        mode,
        context: mode === 'chat' ? normalizeContext(input.automationCreateContext) : null,
      });
    },
    render(observation) {
      if (observation.mode !== 'chat') return [];

      const sections = [{
        id: 'automation.intent-policy',
        layer: 'L5_TOOL_RULES',
        priority: 20,
        title: 'Automation intent policy',
        content: renderPolicy(),
        source: {
          id: 'automation.intent-policy',
          kind: 'tool-policy',
          mode: observation.mode,
        },
        trust: 'runtime',
      }];

      const stateContent = renderState(observation);
      if (stateContent) {
        sections.push({
          id: 'runtime.automation-create-state',
          layer: 'L7_CONTINUITY',
          priority: 25,
          title: 'Automation creation state',
          content: stateContent,
          source: {
            id: 'automation.intent-policy',
            kind: 'conversation-metadata',
            mode: observation.mode,
            contextSource: observation.context.source,
            status: observation.context.status,
            proposalId: observation.context.proposalId,
            proposalStatus: observation.context.proposalStatus,
          },
          trust: 'runtime',
        });
      }

      return sections;
    },
  };
}
