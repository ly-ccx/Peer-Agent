export interface BillingUsageItem {
  readonly key: string;
  readonly label: string;
  readonly amount: string | number;
  readonly unit?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CurrencyAmountBreakdown {
  readonly currency: string;
  readonly amount: string;
}

export interface ConversationBillingSummary {
  readonly conversationId: number;
  readonly agentId?: number;
  readonly currency?: string;
  readonly totalTokens?: number;
  readonly llmCallCount?: number;
  readonly totalCostBreakdown?: readonly CurrencyAmountBreakdown[];
  readonly businessCostBreakdown?: readonly CurrencyAmountBreakdown[];
  readonly systemCostBreakdown?: readonly CurrencyAmountBreakdown[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly toolCallCount?: number;
  readonly items?: readonly BillingUsageItem[];
  readonly updatedAt?: string;
}

export interface AgentBillingSummary extends ConversationBillingSummary {
  readonly agentId: number;
  readonly conversationCount: number;
  readonly sampledConversationCount?: number;
  readonly partial?: boolean;
}
