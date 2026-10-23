export type ProjectCommand =
  | { kind: 'text'; text: string }
  | { kind: 'retry_input'; inputId: string }
  | { kind: 'save_draft' }
  | { kind: 'view'; view: 'bots'|'tasks'|'memory'|'objectives'|'cards'|'diagnostics' }
  | { kind: 'task'; number: number }
  | { kind: 'card'; operation: 'approve'|'deny'|'answer'|'action'; number: number; text: string; option?: number }
  | { kind: 'takeover'|'classic'|'older'|'latest'|'help' }
  | { kind: 'invalid' };

export function parseProjectCommand(input: string): ProjectCommand {
  const text = input.trim();
  if (!text.startsWith('/')) return {kind:'text',text};
  const [name, ...args] = text.slice(1).split(/\s+/);
  if (['bots','tasks','memory','objectives','cards','diagnostics'].includes(name!) && !args.length) return {kind:'view',view:name as any};
  if (['takeover','classic','older','latest','help'].includes(name!) && !args.length) return {kind:name as any};
  if (name === 'save-draft' && !args.length) return {kind:'save_draft'};
  if (name === 'retry-input' && args.length === 1 && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(args[0]!)) return {kind:'retry_input',inputId:args[0]!};
  const number = Number(args[0]);
  if (!/^[1-9]\d{0,5}$/.test(args[0] ?? '')) return {kind:'invalid'};
  if (name === 'task' && args.length === 1) return {kind:'task',number};
  if (['approve','deny'].includes(name!) && args.length === 1) return {kind:'card',operation:name as any,number,text:''};
  if (name === 'answer' && args.slice(1).join(' ').trim()) return {kind:'card',operation:'answer',number,text:args.slice(1).join(' ')};
  if (name === 'action' && args.length === 2 && /^[1-9]\d{0,3}$/.test(args[1]!)) return {kind:'card',operation:'action',number,text:'',option:Number(args[1])};
  return {kind:'invalid'};
}

export interface NumberedCard { number: number; card: any }
/** Numbers are never reused within one workspace, even after a card disappears. */
export function createCardNumbers() {
  let workspaceId = '', next = 1;
  const assigned = new Map<string, number>();
  return { project(id: string, messages: readonly any[]): NumberedCard[] {
    if (workspaceId !== id) { workspaceId = id; assigned.clear(); next = 1; }
    const unique = new Map<string, any>();
    for (const message of messages) for (const card of message.cards ?? []) {
      if (typeof card.cardId === 'string') unique.set(card.cardId, card);
    }
    return [...unique.values()].filter(card=>card.resolvedState !== 'resolved').map(card => {
      if (!assigned.has(card.cardId)) assigned.set(card.cardId, next++);
      return {number:assigned.get(card.cardId)!,card};
    }).sort((a,b)=>a.number-b.number);
  }};
}

export function cardAction(command: Extract<ProjectCommand,{kind:'card'}>, cards: readonly NumberedCard[]) {
  const row = cards.find(item=>item.number===command.number);
  if (!row) return null;
  const actions = row.card.actions ?? [];
  const action = command.operation === 'action' ? actions[command.option! - 1]
    : actions.find((item: any) => command.operation === 'approve' ? ['allow','approve','continue'].includes(item.id)
      : command.operation === 'deny' ? item.id === 'reject' : item.id === 'answer');
  if (!action) return null;
  return { ...action, payload: { ...action.payload, ...(command.operation === 'answer' ? {text:command.text,answerTo:row.card.cardId} : {}) } };
}

export function terminalText(value: unknown): string {
  return String(value ?? '').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');
}

/**
 * 回复回显：把用户原话压成单行再按显示列宽截断。
 *
 * terminalText 有意保留换行（正文要按原样折行），所以回显必须自己折叠空白，
 * 否则多行原话会把回显撑成多行、混进正文。列宽按 CJK 占 2 计，截断带省略号，
 * 避免中文被切一半且看不出被省略。
 */
export function replyEchoText(content: unknown, maxColumns = 56): string {
  const line = terminalText(content).replace(/\s+/g, ' ').trim();
  if (!line) return '';
  let columns = 0;
  let cut = 0;
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0;
    const wide = code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0x33ff)
      || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xa000 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    );
    if (columns + (wide ? 2 : 1) > maxColumns) return `${line.slice(0, cut).trimEnd()}…`;
    columns += wide ? 2 : 1;
    cut += char.length;
  }
  return line;
}

export function projectEntry(command: {classic?: boolean; bots?: boolean}, hasBot: boolean) {
  if (command.classic) return 'classic';
  if (command.bots) return 'bots';
  return hasBot ? 'conversation' : 'bind';
}
