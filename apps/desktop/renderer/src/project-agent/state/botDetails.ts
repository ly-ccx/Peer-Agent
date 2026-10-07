import { clientApi } from '../../clientApi';
import { createBotDetailsReader } from './botModelState';

// The bot list and model controls consume the same production projection.
export const readBotDetails = createBotDetailsReader(workspaceId => clientApi.projectAgentGet({ workspaceId }));
