import type { AgentCronSessionRecord } from '@zeus-atlas/protocol';
import { recordString } from '../../utils/records';

export interface AutomationFormValues {
  title: string;
  content: string;
  triggerMode: 'daily_6' | 'hourly' | 'every_30_minutes' | 'every_10_minutes' | 'custom_cron';
  cronExpr?: string;
  completionType: 'manual_only' | 'goal_achieved' | 'max_runs';
  maxRuns?: number;
  deliveryTarget: 'dingtalk_self' | 'in_conversation_only';
  deliveryMode: 'always' | 'condition';
  deliveryCondition?: string;
}

export function defaultFormValues(): AutomationFormValues {
  return {
    title: 'Automation',
    content: '',
    triggerMode: 'daily_6',
    completionType: 'manual_only',
    maxRuns: 1,
    deliveryTarget: 'dingtalk_self',
    deliveryMode: 'always',
    deliveryCondition: '',
  };
}

export function resolveTrigger(values: AutomationFormValues) {
  if (values.triggerMode === 'hourly') {
    return { triggerType: 'cron' as const, cronExpr: '0 * * * *' };
  }
  if (values.triggerMode === 'every_30_minutes') {
    return { triggerType: 'interval' as const, intervalMs: 30 * 60 * 1000 };
  }
  if (values.triggerMode === 'every_10_minutes') {
    return { triggerType: 'interval' as const, intervalMs: 10 * 60 * 1000 };
  }
  if (values.triggerMode === 'custom_cron') {
    return { triggerType: 'cron' as const, cronExpr: values.cronExpr || '' };
  }
  return { triggerType: 'cron' as const, cronExpr: '0 6 * * *' };
}

export interface DeliveryConfig {
  [key: string]: unknown;
  type: 'dingtalk_self' | 'in_conversation_only';
  condition?: {
    enabled: boolean;
    type: 'natural_language';
    mode: 'run_output_gate';
    prompt: string;
    evaluator: { type: 'llm_judge'; modelPolicy: 'inherit_automation_model'; toolAccess: 'none' };
    onEvaluatorError: 'fail_closed';
  };
}

export function buildDeliveryConfig(values: AutomationFormValues): DeliveryConfig {
  if (values.deliveryTarget === 'in_conversation_only') {
    return { type: 'in_conversation_only' };
  }
  const prompt = String(values.deliveryCondition || '').trim();
  const config: DeliveryConfig = { type: 'dingtalk_self' };
  if (values.deliveryMode === 'condition' && prompt) {
    config.condition = {
      enabled: true,
      type: 'natural_language',
      mode: 'run_output_gate',
      prompt,
      evaluator: { type: 'llm_judge', modelPolicy: 'inherit_automation_model', toolAccess: 'none' },
      onEvaluatorError: 'fail_closed',
    };
  }
  return config;
}

export function buildTaskTemplateJson(values: AutomationFormValues) {
  return {
    content: values.content,
    delivery: { enabled: values.deliveryTarget === 'dingtalk_self' },
  };
}

export function resolveCompletionPolicy(values: AutomationFormValues) {
  if (values.completionType === 'goal_achieved') {
    return { type: 'goal_achieved' };
  }
  if (values.completionType === 'max_runs') {
    return { type: 'max_runs', maxRuns: Math.max(1, Number(values.maxRuns) || 1) };
  }
  return { type: 'manual_only' };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function resolveEffectiveDeliveryConfig(session: AgentCronSessionRecord): Record<string, unknown> {
  const scheduleDelivery = asRecord(session.schedule?.deliveryConfigJson);
  if (Object.keys(scheduleDelivery).length > 0) return scheduleDelivery;
  return asRecord((session as Record<string, unknown>).deliveryConfigJson);
}

function resolveDeliveryConditionPrompt(deliveryConfig: Record<string, unknown>): string {
  const condition = asRecord(deliveryConfig.condition);
  if (condition.enabled === false) return '';
  return String(condition.prompt || '').trim();
}

function resolveDeliveryTarget(session: AgentCronSessionRecord): AutomationFormValues['deliveryTarget'] {
  const deliveryConfig = resolveEffectiveDeliveryConfig(session);
  const scheduleTemplateDelivery = asRecord(asRecord(session.schedule?.taskTemplateJson).delivery);
  const sessionTemplateDelivery = asRecord(asRecord((session as Record<string, unknown>).taskTemplateSnapshotJson).delivery);
  const taskDeliveryEnabled = scheduleTemplateDelivery.enabled ?? sessionTemplateDelivery.enabled;

  if (
    deliveryConfig.enabled === false ||
    deliveryConfig.type === 'in_conversation_only' ||
    taskDeliveryEnabled === false
  ) {
    return 'in_conversation_only';
  }
  return 'dingtalk_self';
}

export function inferFormValuesFromSession(session: AgentCronSessionRecord): AutomationFormValues {
  const schedule = session.schedule;
  let triggerMode: AutomationFormValues['triggerMode'] = 'daily_6';
  let cronExpr: string | undefined;

  if (schedule?.triggerType === 'interval') {
    const ms = Number(schedule.intervalMs || 0);
    if (ms === 30 * 60 * 1000) triggerMode = 'every_30_minutes';
    else if (ms === 10 * 60 * 1000) triggerMode = 'every_10_minutes';
    else triggerMode = 'custom_cron';
  } else if (schedule?.triggerType === 'cron') {
    const expr = String(schedule.cronExpr || '').trim();
    if (expr === '0 * * * *') triggerMode = 'hourly';
    else if (expr === '0 6 * * *') triggerMode = 'daily_6';
    else {
      triggerMode = 'custom_cron';
      cronExpr = expr;
    }
  }

  const policy = asRecord(schedule?.completionPolicyJson);
  const completionType = (policy.type as AutomationFormValues['completionType']) || 'manual_only';
  const maxRuns = Number(policy.maxRuns) || 1;
  const taskTpl = asRecord(schedule?.taskTemplateJson);
  const deliveryConfig = resolveEffectiveDeliveryConfig(session);
  const deliveryCondition = resolveDeliveryConditionPrompt(deliveryConfig);

  return {
    title: session.title || 'Automation',
    content: String(taskTpl.content || recordString(session, ['description', 'prompt', 'instruction', 'content']) || ''),
    triggerMode,
    cronExpr,
    completionType,
    maxRuns,
    deliveryTarget: resolveDeliveryTarget(session),
    deliveryMode: deliveryCondition ? 'condition' : 'always',
    deliveryCondition,
  };
}

export type TriggerModeOption = {
  readonly value: AutomationFormValues['triggerMode'];
  readonly label: string;
};

export const triggerModeOptions: readonly TriggerModeOption[] = [
  { value: 'daily_6', label: '每天 06:00' },
  { value: 'hourly', label: '每小时' },
  { value: 'every_30_minutes', label: '每 30 分钟' },
  { value: 'every_10_minutes', label: '每 10 分钟' },
  { value: 'custom_cron', label: '自定义 Cron' },
];

export function validateFormValues(values: AutomationFormValues): string | null {
  if (!values.title.trim()) return '请输入目标名称';
  if (!values.content.trim()) return '请输入 Agent 指令';
  const trigger = resolveTrigger(values);
  if (trigger.triggerType === 'cron' && !trigger.cronExpr) return 'Cron 表达式不能为空';
  if (values.completionType === 'max_runs' && (!values.maxRuns || values.maxRuns < 1)) return '最多运行次数至少为 1';
  if (values.deliveryTarget === 'dingtalk_self' && values.deliveryMode === 'condition' && !values.deliveryCondition?.trim()) {
    return '请输入推送条件';
  }
  return null;
}
