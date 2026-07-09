// 待发送消息队列已经下沉到 conversationStore 会话桶。
// 保留这个文件只作为历史 import 的类型兼容出口；不要再新增组件本地 queue hook，
// 否则会重新制造「切会话时旧队列被新 conversationId 消费」的共享状态风险。
export type { QueuedMessage } from '../state/types';
