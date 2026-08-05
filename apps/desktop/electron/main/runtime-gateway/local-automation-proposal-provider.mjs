import { createPermissionGrant, nowIso } from './tool-result-factory.mjs';

export const AUTOMATION_PROPOSAL_CAPABILITY_ID = 'local.automation.propose';

const SCHEDULE_KINDS = new Set([
  'once',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'custom_cron',
]);
const CONFIDENCE_LEVELS = new Set(['high', 'medium']);
const ACCESS_PRESETS = new Set(['observe', 'work_in_workspace']);

function parseArgs(call) {
  const raw = call?.arguments;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function boundedInteger(value, label, minimum, maximum, fallback = null) {
  if (value === undefined && fallback !== null) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function systemTimezone(resolveTimezone) {
  const resolved = typeof resolveTimezone === 'function'
    ? resolveTimezone()
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof resolved === 'string' && resolved.trim() ? resolved.trim() : 'UTC';
}

function normalizeSchedule(value, timezone) {
  if (!value || typeof value !== 'object') throw new TypeError('schedule is required');
  const kind = requiredString(value.kind, 'schedule.kind');
  if (!SCHEDULE_KINDS.has(kind)) throw new TypeError(`unsupported schedule.kind: ${kind}`);

  const schedule = { kind, timezone };
  if (kind === 'once') {
    schedule.onceAt = requiredString(value.onceAt, 'schedule.onceAt');
  } else if (kind === 'hourly') {
    schedule.everyHours = boundedInteger(value.everyHours, 'schedule.everyHours', 1, 24, 1);
  } else if (kind === 'custom_cron') {
    schedule.cron = requiredString(value.cron, 'schedule.cron');
  } else {
    schedule.hour = boundedInteger(value.hour, 'schedule.hour', 0, 23, 9);
    schedule.minute = boundedInteger(value.minute, 'schedule.minute', 0, 59, 0);
    if (kind === 'weekly') {
      if (!Array.isArray(value.weekdays) || value.weekdays.length === 0) {
        throw new TypeError('schedule.weekdays is required for weekly schedules');
      }
      schedule.weekdays = [...new Set(value.weekdays.map((day) => (
        boundedInteger(day, 'schedule.weekdays[]', 1, 7)
      )))].sort((left, right) => left - right);
    }
    if (kind === 'monthly') {
      schedule.dayOfMonth = boundedInteger(value.dayOfMonth, 'schedule.dayOfMonth', 1, 31, 1);
    }
  }
  return schedule;
}

export function buildBoundAutomationCreateInput({
  args,
  workspacePath,
  timezone,
  confirmedAt,
} = {}) {
  const boundWorkspace = requiredString(workspacePath, 'toolContext.workspacePath');
  const confidence = requiredString(args?.confidence, 'confidence');
  if (!CONFIDENCE_LEVELS.has(confidence)) throw new TypeError('confidence must be high or medium');
  const access = args?.access ?? 'observe';
  if (!ACCESS_PRESETS.has(access)) throw new TypeError(`unsupported access preset: ${access}`);
  const writing = access === 'work_in_workspace';
  const timeoutMinutes = boundedInteger(args?.timeoutMinutes, 'timeoutMinutes', 1, 1440, 30);

  return Object.freeze({
    confidence,
    definition: {
      name: requiredString(args?.name, 'name'),
      prompt: requiredString(args?.prompt, 'prompt'),
      workspacePath: boundWorkspace,
      modelProviderId: null,
      schedule: normalizeSchedule(args?.schedule, requiredString(timezone, 'timezone')),
      grant: {
        preset: access,
        workspacePath: boundWorkspace,
        allowedCapabilityIds: writing
          ? ['local.file.read', 'local.file.write', 'local.shell.exec']
          : ['local.file.read'],
        askCapabilityIds: [],
        blockedCapabilityIds: writing ? [] : ['local.file.write', 'local.shell.exec'],
        confirmedAt,
        version: 1,
      },
      notifications: {
        needsAttention: 'system_and_badge',
        failed: true,
        succeeded: args?.notifySuccess === true,
      },
      budget: { timeoutMs: timeoutMinutes * 60_000 },
      missedRunPolicy: 'run_latest',
      overlapPolicy: 'skip',
      enable: true,
    },
  });
}

export function createLocalAutomationProposalProvider({
  proposalService = null,
  resolveTimezone = null,
  now = nowIso,
} = {}) {
  async function executeCapability(request, context = {}) {
    const call = request?.call ?? {};
    const locale = context.locale ?? 'zh-CN';
    let status = 'success';
    let payload;

    try {
      if (call.capabilityId !== AUTOMATION_PROPOSAL_CAPABILITY_ID) {
        throw new Error(`unsupported automation capability: ${call.capabilityId ?? 'missing'}`);
      }
      if (!proposalService || typeof proposalService.propose !== 'function') {
        throw new Error('automation_proposal_service_unavailable');
      }
      const conversationId = requiredString(
        context.toolContext?.conversationId,
        'toolContext.conversationId',
      );
      const workspacePath = requiredString(
        context.toolContext?.workspacePath,
        'toolContext.workspacePath',
      );
      const timestamp = now();
      const normalized = buildBoundAutomationCreateInput({
        args: parseArgs(call),
        workspacePath,
        timezone: systemTimezone(resolveTimezone),
        confirmedAt: timestamp,
      });
      const outcome = await proposalService.propose({
        conversationId,
        definition: normalized.definition,
        source: 'chat_intent',
        confidence: normalized.confidence,
      });
      payload = { ok: true, ...outcome };
    } catch (error) {
      status = 'failed';
      payload = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const output = JSON.stringify(payload);
    const proposal = payload?.proposal ?? null;
    const summary = status === 'success'
      ? proposal
        ? `Automation proposal ${proposal.proposalId} is ${proposal.status}.`
        : `Automation proposal was suppressed (${payload.reason ?? 'unknown reason'}).`
      : `Automation proposal failed: ${payload.error}`;

    return {
      call,
      grant: createPermissionGrant({
        toolCallId: call.toolCallId,
        granted: status === 'success',
        scope: AUTOMATION_PROPOSAL_CAPABILITY_ID,
      }),
      result: {
        toolCallId: call.toolCallId,
        status,
        outputPreview: payload,
        output,
        bytes: Buffer.byteLength(output, 'utf8'),
        mimeType: 'application/json',
        truncated: false,
        evidence: {
          evidenceId: `automation-proposal-${call.toolCallId}`,
          toolCallId: call.toolCallId,
          summary,
          locale,
          returnedToCloud: true,
          dataLevel: 'D2_sensitive',
          redactions: [],
          artifactRefs: [],
        },
        completedAt: now(),
      },
    };
  }

  return {
    providerId: AUTOMATION_PROPOSAL_CAPABILITY_ID,
    capabilityIds: [AUTOMATION_PROPOSAL_CAPABILITY_ID],
    executeCapability,
  };
}
