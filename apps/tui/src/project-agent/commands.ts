export type ProjectCommand =
  | { kind: 'text'; text: string }
  | { kind: 'view'; view: 'bots'|'tasks'|'memory'|'objectives'|'cards' }
  | { kind: 'task'; number: number }
  | { kind: 'card'; operation: 'approve'|'deny'|'answer'|'action'; number: number; text: string; option?: number }
  | { kind: 'takeover'|'classic'|'older'|'latest'|'help' }
  | { kind: 'invalid' };

export function parseProjectCommand(input: string): ProjectCommand {
  const text = input.trim();
  if (!text.startsWith('/')) return {kind:'text',text};
  const [name, ...args] = text.slice(1).split(/\s+/);
  if (['bots','tasks','memory','objectives','cards'].includes(name!) && !args.length) return {kind:'view',view:name as any};
  if (['takeover','classic','older','latest','help'].includes(name!) && !args.length) return {kind:name as any};
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

export function projectEntry(command: {classic?: boolean; bots?: boolean}, hasBot: boolean) {
  if (command.classic) return 'classic';
  if (command.bots) return 'bots';
  return hasBot ? 'conversation' : 'bind';
}
