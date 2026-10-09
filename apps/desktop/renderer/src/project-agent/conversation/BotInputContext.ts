import { createContext } from 'react';

/** Cards reuse the conversation's optimistic send and receipt lifecycle. */
export const BotInputContext = createContext<((text: string, answerTo?: string) => Promise<{ ok: boolean; code?: string }>) | null>(null);
