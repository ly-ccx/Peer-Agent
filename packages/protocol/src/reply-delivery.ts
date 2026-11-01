/** The old delivered aggregate still requires both canonical commit and host settlement. */
export interface ReplyDeliveryReceipt {
  readonly state: 'prepared' | 'delivered' | 'invalidated';
  readonly canonicalCommittedAt?: string;
  readonly settlement?: {
    readonly operationId: string;
    readonly status: 'pending' | 'failed' | 'applied';
    readonly attempts: number;
    readonly updatedAt: string;
    readonly phase?: 'commit' | 'settlement';
    readonly error?: string;
    readonly retryAt?: string;
  };
}
