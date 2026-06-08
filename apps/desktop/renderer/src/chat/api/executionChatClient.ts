import type {
  DispatchConfirmResult,
  ExecutionCancelResult,
  ExecutionCotSnapshot,
  ExecutionDetailData,
  ExecutionListData,
  ExecutionResultData,
  ExecutionSourceTraceData,
  ExecutionStatusSnapshot,
  PendingDispatchResult,
  RelatedShadowExecutionListData,
} from '@zeus-atlas/protocol';
import { clientApi } from '../../clientApi';
import { unwrap } from './apiResponse';
import {
  normalizeExecutionListData,
  normalizeRelatedShadowExecutionListData,
} from './chatNormalizers';

export const executionChatClient = {
  async getExecutionStatus(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getExecutionStatus']>[0]): Promise<ExecutionStatusSnapshot> {
    return unwrap(await clientApi.chat.getExecutionStatus(params), '加载执行状态失败');
  },
  async getExecutionDetail(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getExecutionDetail']>[0]): Promise<ExecutionDetailData> {
    return unwrap(await clientApi.chat.getExecutionDetail(params), '加载执行详情失败');
  },
  async getExecutionResult(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getExecutionResult']>[0]): Promise<ExecutionResultData> {
    return unwrap(await clientApi.chat.getExecutionResult(params), '加载执行结果失败');
  },
  async getExecutionCot(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getExecutionCot']>[0]): Promise<ExecutionCotSnapshot> {
    return unwrap(await clientApi.chat.getExecutionCot(params), '加载执行事件失败');
  },
  async traceExecutionSource(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['traceExecutionSource']>[0]): Promise<ExecutionSourceTraceData> {
    return unwrap(await clientApi.chat.traceExecutionSource(params), '加载执行来源追踪失败');
  },
  async listExecutions(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listExecutions']>[0]): Promise<ExecutionListData> {
    return normalizeExecutionListData(unwrap(await clientApi.chat.listExecutions(params), '加载执行列表失败'));
  },
  async listRelatedShadowExecutions(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listRelatedShadowExecutions']>[0]): Promise<RelatedShadowExecutionListData> {
    return normalizeRelatedShadowExecutionListData(unwrap(await clientApi.chat.listRelatedShadowExecutions(params), '加载相关 Shadow 执行失败'));
  },
  async cancelExecution(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['cancelExecution']>[0]): Promise<ExecutionCancelResult> {
    return unwrap(await clientApi.chat.cancelExecution(params), '取消执行失败');
  },
  async getPendingDispatch(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getPendingDispatch']>[0]): Promise<PendingDispatchResult> {
    return unwrap(await clientApi.chat.getPendingDispatch(params), '加载待确认调度失败');
  },
  async confirmDispatch(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['confirmDispatch']>[0]): Promise<DispatchConfirmResult> {
    return unwrap(await clientApi.chat.confirmDispatch(params), '确认调度失败');
  },
  getThinkingDetail: clientApi.chat.getThinkingDetail,
  updateThinkingUiState: clientApi.chat.updateThinkingUiState,
};
