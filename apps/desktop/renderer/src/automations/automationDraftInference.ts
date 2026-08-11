export type InferredScheduleKind =
  | 'once'
  | 'hourly'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly';

export type InferredAutomationDraft = {
  readonly name: string;
  readonly scheduleKind: InferredScheduleKind;
  readonly hour: number;
  readonly minute: number;
  readonly everyHours: number;
  readonly onceAt: string;
  readonly detectedSchedule: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function defaultOnceAt(from = new Date()): string {
  const next = new Date(from.getTime() + 60 * 60 * 1000);
  return `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-${pad2(next.getDate())}T${pad2(next.getHours())}:${pad2(next.getMinutes())}`;
}

function extractClock(text: string): { hour: number; minute: number } | null {
  const colon = text.match(/\b([01]?\d|2[0-3])[:：]([0-5]\d)\b/);
  if (colon) {
    return { hour: Number(colon[1]), minute: Number(colon[2]) };
  }

  const chinese = text.match(/(?:凌晨|早上|上午|中午|下午|晚上|今晚)?\s*([01]?\d|2[0-3])\s*点(?:\s*([0-5]?\d)\s*分?)?/);
  if (chinese) {
    let hour = Number(chinese[1]);
    const minute = chinese[2] ? Number(chinese[2]) : 0;
    if (/下午|晚上|今晚/.test(text) && hour < 12) hour += 12;
    if (/中午/.test(text) && hour < 11) hour = 12;
    if (/凌晨|早上|上午/.test(text) && hour === 12) hour = 0;
    return { hour: clamp(hour, 0, 23), minute: clamp(minute, 0, 59) };
  }

  return null;
}

function stripSchedulePhrases(text: string): string {
  return text
    .replace(/(每个工作日|每天|每日|工作日|每周|每小时|每月|每个|每\s*\d+\s*小时|once|daily|hourly|weekly|weekdays|monthly|every\s+weekday|every\s+day|every\s+hour|every\s+week|every\s+month)/gi, ' ')
    .replace(/(?:凌晨|早上|上午|中午|下午|晚上|今晚)?\s*(?:[01]?\d|2[0-3])\s*点(?:\s*[0-5]?\d\s*分?)?/g, ' ')
    .replace(/\b([01]?\d|2[0-3])[:：]([0-5]\d)\b/g, ' ')
    .replace(/\b\d{1,2}\s*点\b/g, ' ')
    .replace(/[，,。.!！?？；;：:\s]+/g, ' ')
    .trim();
}

export function inferAutomationName(prompt: string): string {
  const cleaned = stripSchedulePhrases(prompt)
    .replace(/^请?帮我?/, '')
    .replace(/^(please\s+)?(help\s+me\s+)?/i, '')
    .trim();
  const firstLine = (cleaned.split(/\n/)[0] ?? '').trim();
  const base = firstLine || prompt.trim().split(/\n/)[0]?.trim() || 'Automation';
  const compact = base.replace(/\s+/g, ' ').slice(0, 36).trim();
  return compact || 'Automation';
}

export function inferAutomationSchedule(
  prompt: string,
  now = new Date(),
): Omit<InferredAutomationDraft, 'name'> {
  const text = prompt.trim();
  const clock = extractClock(text) ?? { hour: 9, minute: 0 };
  let scheduleKind: InferredScheduleKind = 'daily';
  let detectedSchedule = false;
  let everyHours = 1;

  if (/(每小时|每\s*(?:\d+\s*)?小时|hourly|every\s+(?:\d+\s+)?hours?)/i.test(text)) {
    scheduleKind = 'hourly';
    detectedSchedule = true;
    const every = text.match(/每\s*(\d+)\s*小时|every\s+(\d+)\s*hours?/i);
    if (every) everyHours = clamp(Number(every[1] || every[2] || 1), 1, 24);
  } else if (/(工作日|weekdays?|mon(?:day)?\s*[-–to]+\s*fri(?:day)?)/i.test(text)) {
    scheduleKind = 'weekdays';
    detectedSchedule = true;
  } else if (/(每周|weekly|every\s+week)/i.test(text)) {
    scheduleKind = 'weekly';
    detectedSchedule = true;
  } else if (/(每月|monthly|every\s+month)/i.test(text)) {
    scheduleKind = 'monthly';
    detectedSchedule = true;
  } else if (/(每天|每日|daily|every\s+day)/i.test(text)) {
    scheduleKind = 'daily';
    detectedSchedule = true;
  } else if (/(一次|单次|once|明天|今晚|today|tomorrow)/i.test(text)) {
    scheduleKind = 'once';
    detectedSchedule = true;
  }

  if (extractClock(text)) detectedSchedule = true;

  let onceAt = defaultOnceAt(now);
  if (scheduleKind === 'once') {
    const target = new Date(now);
    if (/明天|tomorrow/i.test(text)) target.setDate(target.getDate() + 1);
    target.setHours(clock.hour, clock.minute, 0, 0);
    if (target.getTime() <= now.getTime() && !/明天|tomorrow/i.test(text)) {
      target.setDate(target.getDate() + 1);
    }
    onceAt = `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}T${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  }

  return {
    scheduleKind,
    hour: clock.hour,
    minute: clock.minute,
    everyHours,
    onceAt,
    detectedSchedule,
  };
}

/** First-pass detection from a task description. */
export function inferAutomationDraftFromPrompt(
  prompt: string,
  now = new Date(),
): InferredAutomationDraft {
  const normalized = prompt.trim();
  const schedule = inferAutomationSchedule(normalized, now);
  return {
    name: inferAutomationName(normalized),
    ...schedule,
  };
}

export function canInferAutomationDraft(prompt: string): boolean {
  return prompt.trim().length >= 4;
}

export type LlmAutomationDetection = {
  readonly name: string;
  readonly scheduleKind: InferredScheduleKind;
  readonly hour: number;
  readonly minute: number;
  readonly everyHours: number;
  readonly onceAt: string;
  readonly source: 'llm' | 'local';
};

export function buildAutomationDetectionPrompt(taskPrompt: string, locale: 'en' | 'zh' = 'zh'): string {
  const instruction = locale === 'zh'
    ? '你是自动化计划助手。根据用户任务描述，生成自动化名称与时间计划。只输出 JSON，不要解释。'
    : 'You are an automation planner. From the task description, produce a name and schedule. Output JSON only.';
  const schema = `{
  "name": "short automation name",
  "scheduleKind": "once|hourly|daily|weekdays|weekly|monthly",
  "hour": 0-23,
  "minute": 0-59,
  "everyHours": 1-24,
  "onceAt": "YYYY-MM-DDTHH:mm or empty"
}`;
  return `${instruction}\nSchema:\n${schema}\nTask:\n${taskPrompt.trim()}`;
}

export function parseLlmAutomationDetectionText(raw: string): LlmAutomationDetection | null {
  if (!raw || !raw.trim()) return null;
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const name = String(data.name ?? '').trim().slice(0, 80);
    if (!name) return null;
    const kindRaw = String(data.scheduleKind ?? data.kind ?? 'daily').toLowerCase();
    const allowed: InferredScheduleKind[] = ['once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly'];
    const scheduleKind = (allowed.includes(kindRaw as InferredScheduleKind)
      ? kindRaw
      : 'daily') as InferredScheduleKind;
    const hour = Math.max(0, Math.min(23, Number(data.hour ?? 9) || 9));
    const minute = Math.max(0, Math.min(59, Number(data.minute ?? 0) || 0));
    const everyHours = Math.max(1, Math.min(24, Number(data.everyHours ?? 1) || 1));
    let onceAt = String(data.onceAt ?? '').trim();
    if (scheduleKind === 'once' && !onceAt) {
      onceAt = defaultOnceAt();
    }
    return {
      name,
      scheduleKind,
      hour,
      minute,
      everyHours,
      onceAt: scheduleKind === 'once' ? onceAt : '',
      source: 'llm',
    };
  } catch {
    return null;
  }
}

export function detectionToDraftPatch(detection: LlmAutomationDetection): {
  name: string;
  scheduleKind: InferredScheduleKind;
  hour: number;
  minute: number;
  everyHours: number;
  onceAt: string;
} {
  return {
    name: detection.name,
    scheduleKind: detection.scheduleKind,
    hour: detection.hour,
    minute: detection.minute,
    everyHours: detection.everyHours,
    onceAt: detection.onceAt,
  };
}
