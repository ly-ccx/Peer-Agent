import type { AutomationAccessPreset, AutomationCreateInput, AutomationDefinition, AutomationScheduleKind } from '@peer-agent/protocol';
import { systemAutomationTimezone, timezoneForExistingAutomation } from './automationTimezoneBinding.ts';
import { workspaceForExistingAutomation, workspaceForNewAutomation } from './automationWorkspaceBinding.ts';
export interface Draft {
  name: string;
  prompt: string;
  workspacePath: string;
  scheduleKind: AutomationScheduleKind;
  timezone: string;
  onceAt: string;
  hour: number;
  minute: number;
  everyHours: number;
  dayOfMonth: number;
  cron: string;
  access: AutomationAccessPreset;
  notifySuccess: boolean;
  notifySuccessOnlyOnChange: boolean;
  timeoutMinutes: number;
}

export function blankDraft(defaultWorkspace: string, promptTemplate = ''): Draft {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  return {
    name: '', prompt: promptTemplate, workspacePath: workspaceForNewAutomation(defaultWorkspace), scheduleKind: 'daily',
    timezone: systemAutomationTimezone(),
    onceAt: next.toISOString().slice(0, 16), hour: 9, minute: 0, everyHours: 1,
    dayOfMonth: 1, cron: '0 9 * * *', access: 'observe', notifySuccess: false,
    notifySuccessOnlyOnChange: true, timeoutMinutes: 30,
  };
}

export function draftFromDefinition(value: AutomationDefinition): Draft {
  return {
    name: value.name, prompt: value.prompt,
    workspacePath: workspaceForExistingAutomation(value.workspacePath),
    scheduleKind: value.schedule.kind,
    timezone: timezoneForExistingAutomation(value.schedule.timezone),
    onceAt: value.schedule.onceAt?.slice(0, 16) ?? '', hour: value.schedule.hour ?? 9,
    minute: value.schedule.minute ?? 0, everyHours: value.schedule.everyHours ?? 1,
    dayOfMonth: value.schedule.dayOfMonth ?? 1, cron: value.schedule.cron ?? '0 9 * * *',
    access: value.grant.preset, notifySuccess: value.notifications.succeeded,
    notifySuccessOnlyOnChange: value.notifications.succeededOnlyOnChange ?? true,
    timeoutMinutes: Math.max(1, Math.round(value.budget.timeoutMs / 60_000)),
  };
}

export function inputFromDraft(draft: Draft): AutomationCreateInput {
  const schedule = {
    kind: draft.scheduleKind, timezone: draft.timezone,
    ...(draft.scheduleKind === 'once' ? { onceAt: new Date(draft.onceAt).toISOString() } : {}),
    ...(draft.scheduleKind === 'hourly' ? { everyHours: draft.everyHours, minute: draft.minute } : {}),
    ...(['daily', 'weekdays', 'weekly', 'monthly'].includes(draft.scheduleKind) ? { hour: draft.hour, minute: draft.minute } : {}),
    ...(draft.scheduleKind === 'weekly' ? { weekdays: [1] } : {}),
    ...(draft.scheduleKind === 'monthly' ? { dayOfMonth: draft.dayOfMonth } : {}),
    ...(draft.scheduleKind === 'custom_cron' ? { cron: draft.cron } : {}),
  } as AutomationCreateInput['schedule'];
  const writing = draft.access === 'work_in_workspace';
  return {
    name: draft.name.trim(), prompt: draft.prompt.trim(), workspacePath: draft.workspacePath.trim(), schedule,
    grant: {
      preset: draft.access, workspacePath: draft.workspacePath.trim(),
      allowedCapabilityIds: writing
        ? ['local.file.read', 'local.file.write', 'local.shell.exec']
        : ['local.file.read'],
      askCapabilityIds: [],
      blockedCapabilityIds: writing ? [] : ['local.file.write', 'local.shell.exec'],
      confirmedAt: new Date().toISOString(), version: 1,
    },
    notifications: {
      needsAttention: 'system_and_badge', failed: true, succeeded: draft.notifySuccess,
      succeededOnlyOnChange: draft.notifySuccessOnlyOnChange,
    },
    budget: { timeoutMs: draft.timeoutMinutes * 60_000 }, missedRunPolicy: 'run_latest',
    overlapPolicy: 'skip', enable: true,
  };
}

// Presentation recovery only. Pending/unknown is never a permission or execution claim.
type RetainedDraft = { readonly draft: Draft; readonly definition: AutomationDefinition | null; readonly state: 'editing' | 'pending' | 'unconfirmed' | 'confirmed' };
const retainedDrafts = new Map<string, RetainedDraft>();
const listeners = new Set<() => void>();
const publish = (key: string, entry?: RetainedDraft) => {
  if (entry) retainedDrafts.set(key, entry); else retainedDrafts.delete(key);
  listeners.forEach(listener => listener());
};
export const automationEditorDrafts = {
  get: (key: string) => retainedDrafts.get(key),
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  retain(key: string, draft: Draft, definition: AutomationDefinition | null) {
    const previous = retainedDrafts.get(key);
    if (previous?.state === 'pending') return;
    publish(key, { draft, definition, state: previous?.state ?? 'editing' });
  },
  begin(key: string, draft: Draft, definition: AutomationDefinition | null) {
    if (['pending', 'confirmed'].includes(retainedDrafts.get(key)?.state ?? '')) throw Error('SAVE_PENDING');
    const entry: RetainedDraft = { draft, definition, state: 'pending' };
    publish(key, entry); return entry;
  },
  finish(key: string, entry: RetainedDraft, confirmed: boolean, definition?: AutomationDefinition) {
    if (retainedDrafts.get(key) !== entry) return;
    publish(key, confirmed && definition ? { ...entry, definition, state: 'confirmed' } : { ...entry, state: 'unconfirmed' });
  },
  reviewed(key: string) {
    const entry = retainedDrafts.get(key);
    if (entry?.state === 'unconfirmed') publish(key, { ...entry, state: 'editing' });
  },
  discard(key: string) { if (retainedDrafts.get(key)?.state !== 'pending') publish(key); },
};
