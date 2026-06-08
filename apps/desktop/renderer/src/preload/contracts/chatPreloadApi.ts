import type { AgentMemoryPreloadApi } from './agentMemoryPreloadApi';
import type { AutomationRoundTablePreloadApi } from './automationRoundTablePreloadApi';
import type { ConversationPreloadApi } from './conversationPreloadApi';
import type { ExecutionPreloadApi } from './executionPreloadApi';
import type { LocalCapabilityPreloadApi } from './localCapabilityPreloadApi';
import type { ObservabilityPreloadApi } from './observabilityPreloadApi';
import type { OpenClawPreloadApi } from './openClawPreloadApi';
import type { ShareAuthPreloadApi } from './shareAuthPreloadApi';

export interface ChatPreloadApi
  extends ConversationPreloadApi,
    ExecutionPreloadApi,
    AgentMemoryPreloadApi,
    ShareAuthPreloadApi,
    AutomationRoundTablePreloadApi,
    ObservabilityPreloadApi,
    OpenClawPreloadApi,
    LocalCapabilityPreloadApi {}
