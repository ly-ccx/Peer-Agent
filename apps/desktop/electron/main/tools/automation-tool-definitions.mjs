export const AUTOMATION_TOOL_DEFINITIONS = [
  {
    name: 'propose_automation_task',
    capabilityId: 'local.automation.propose',
    availableInModes: ['chat'],
    prompt: () => [
      'Create or update a structured automation-task proposal in the current conversation.',
      'Use this only when the user is delegating work to run later or repeatedly, not when they merely discuss cron, timers, tests, or product design.',
      'In an automation-creation conversation, collect missing task or schedule details, then call this tool once the proposal is concrete.',
      'In ordinary chat, call it directly only for high-confidence delegated future/repeating work; for medium confidence ask the user first; for low confidence do not interrupt.',
      'This tool never creates the automation. It only produces a proposal card; creation requires an explicit user confirmation on that card.',
      'Do not ask for workspace path or timezone: the local host binds both from the current conversation and system.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short automation-task name.' },
        prompt: { type: 'string', description: 'Complete task instruction to execute on each run.' },
        schedule: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom_cron'] },
            onceAt: { type: 'string', description: 'ISO timestamp for a one-time run.' },
            everyHours: { type: 'number', minimum: 1 },
            hour: { type: 'number', minimum: 0, maximum: 23 },
            minute: { type: 'number', minimum: 0, maximum: 59 },
            weekdays: { type: 'array', items: { type: 'number', minimum: 1, maximum: 7 } },
            dayOfMonth: { type: 'number', minimum: 1, maximum: 31 },
            cron: { type: 'string', description: 'Five-field minute-level cron expression.' },
          },
          required: ['kind'],
          additionalProperties: false,
        },
        confidence: { type: 'string', enum: ['high', 'medium'] },
        access: { type: 'string', enum: ['observe', 'work_in_workspace'] },
        notifySuccess: { type: 'boolean' },
        timeoutMinutes: { type: 'number', minimum: 1, maximum: 1440 },
      },
      required: ['name', 'prompt', 'schedule', 'confidence'],
      additionalProperties: false,
    },
    runtime: Object.freeze({
      executorCapabilityId: 'local.automation.propose',
      adapter: 'runtime-gateway.local-automation-provider',
    }),
    permissionPolicy: {
      kind: 'conversation-metadata-write',
      rationale: 'Preparing a proposal writes conversation metadata only; creating the automation still requires user confirmation.',
    },
  },
];
