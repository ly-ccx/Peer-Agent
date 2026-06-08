import type { ClientToolCallPollResult } from '@zeus-atlas/protocol';
import { clientApi } from '../../clientApi';
import { unwrap } from './apiResponse';
import { normalizeClientToolCallPollResult } from './chatNormalizers';

export const localCapabilityChatClient = {
  reportClientToolResult: clientApi.chat.reportClientToolResult,
  async pollClientToolCalls(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['pollClientToolCalls']>[0]): Promise<ClientToolCallPollResult> {
    return normalizeClientToolCallPollResult(unwrap(await clientApi.chat.pollClientToolCalls(params), '拉取本地工具任务失败'));
  },
  onStreamDone: clientApi.chat.onStreamDone,
  onStreamError: clientApi.chat.onStreamError,
  onStreamEvent: clientApi.chat.onStreamEvent,
};
