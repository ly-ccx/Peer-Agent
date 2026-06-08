import { agentMemoryChatClient } from './agentMemoryChatClient';
import { automationRoundTableChatClient } from './automationRoundTableChatClient';
import { conversationChatClient } from './conversationChatClient';
import { executionChatClient } from './executionChatClient';
import { localCapabilityChatClient } from './localCapabilityChatClient';
import { observabilityChatClient } from './observabilityChatClient';
import { openClawChatClient } from './openClawChatClient';
import { shareAuthChatClient } from './shareAuthChatClient';

export const chatClient = {
  ...conversationChatClient,
  ...executionChatClient,
  ...agentMemoryChatClient,
  ...shareAuthChatClient,
  ...automationRoundTableChatClient,
  ...observabilityChatClient,
  ...openClawChatClient,
  ...localCapabilityChatClient,
};
