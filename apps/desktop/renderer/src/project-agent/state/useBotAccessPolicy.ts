import { useEffect, useRef, useState } from 'react';
import type { BotAccessPolicyReadRequest, LocalAccessLevel } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { createBotAccessPolicyState, type AccessControlSnapshot } from './botAccessPolicyState';

export function useBotAccessPolicy(request: BotAccessPolicyReadRequest) {
  const identity = request.workspaceId ?? request.conversationId ?? '';
  const [state, setState] = useState<AccessControlSnapshot & { identity: string }>({ identity: '', view: null, busy: false, error: false, loading: true });
  const control = useRef<ReturnType<typeof createBotAccessPolicyState> | null>(null);
  useEffect(() => {
    const controller = createBotAccessPolicyState({ request,
      read: payload => clientApi.projectAgentReadAccessPolicy(payload),
      write: payload => clientApi.projectAgentUpdateAccessPolicy(payload),
      publish: snapshot => setState({ ...snapshot, identity }),
    });
    control.current = controller;
    void controller.refresh();
    const off = clientApi.onProjectAgentChanged(() => void controller.refresh());
    const focus = () => void controller.refresh();
    window.addEventListener('focus', focus);
    return () => { controller.stop(); off?.(); window.removeEventListener('focus', focus); };
  }, [request.workspaceId, request.conversationId]);
  return { ...(state.identity === identity ? state : { view: null, busy: false, error: false, loading: true }),
    save: (level: LocalAccessLevel) => control.current?.save(level), refresh: () => control.current?.refresh() };
}
