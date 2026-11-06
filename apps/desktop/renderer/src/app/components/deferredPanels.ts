import { deferPanel } from './deferPanel';

export const SettingsPage = deferPanel(() => import('./SettingsPage').then(module => ({ default: module.SettingsPage })));
export const CapabilitiesPanel = deferPanel(() => import('./CapabilitiesPanel').then(module => ({ default: module.CapabilitiesPanel })));
export const AutomationCenter = deferPanel(() => import('../../automations/AutomationCenter').then(module => ({ default: module.AutomationCenter })));
export const WorkbenchPanel = deferPanel(() => import('../../workbench/WorkbenchPanel').then(module => ({ default: module.WorkbenchPanel })));
export const QuickChatWindow = deferPanel(() => import('./QuickChatWindow').then(module => ({ default: module.QuickChatWindow })));
export const QuickChatPopoverHost = deferPanel(() => import('./QuickChatPopoverHost').then(module => ({ default: module.QuickChatPopoverHost })));

export const ChatSurface = deferPanel(() => import('../../chat/components/ChatSurface').then(module => ({ default: module.ChatSurface })));
