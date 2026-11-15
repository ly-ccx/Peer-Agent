// Generated from packages/protocol/contracts/native-cli/usage-ledger-v1.json.
export const USAGE_LEDGER_CONTRACT = {
  "schemaVersion": 1,
  "limits": {
    "rowBytes": 262144,
    "intentBytes": 524288,
    "indexBytes": 8388608,
    "indexRows": 4096
  },
  "ledgerRelative": "../usage/requests.jsonl",
  "intentFile": ".usage-ledger-transaction",
  "locks": [
    "conversations/index.jsonl.lock",
    "conversations/.usage-ledger-transaction.lock",
    "usage/requests.jsonl.lock"
  ],
  "intentFields": [
    "schemaVersion",
    "ledgerRelative",
    "conversationId",
    "before",
    "after",
    "ledgerRow",
    "ledgerLine",
    "prefixBytes",
    "prefixSha256"
  ],
  "counterFields": [
    "lifetimeUsage",
    "runtimeTurnCount"
  ],
  "identity": [
    "conversationId",
    "id"
  ],
  "retryIgnoredFields": [
    "at"
  ],
  "usageScope": "runtime_turn",
  "recovery": "Verify prefix and counter before/after; only append exact missing suffix; never truncate unknown bytes."
};
