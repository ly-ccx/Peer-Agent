# Goal Mode Codex + Claude Code Workflow Alignment

## Status

Implementation design with Slice 1-6 core path landed, AgentRunOutcome landed, Manual DoD confirmation landed, and Goal confirmation cards landed on 2026-07-04.

Landed in the current implementation:

- Protocol/store normalization for `accepted`, `goal_self_driven`, `accepted_goal`, and self-driven execution policy.
- `createGoalContract` / `upsertGoalContract` with same-conversation reuse.
- `goal_create_plan` branches by `toolContext.mode`: Plan mode creates `awaiting_approval`, Goal mode creates or revises an `accepted` self-driven Goal.
- Goal-mode user turns deterministically bootstrap an accepted Goal contract before model execution.
- Runner authorization accepts `accepted_goal` without requiring `approval.decision === 'approve'`.
- Prompt sources treat `accepted` as active GoalPlan state.
- Evidence Registry records projected tool refs and rejects completed task / criterion evidence that is not indexed.
- Completion gate validates task and auto-criterion evidence against the indexed refs available to the plan.
- `llmChatService.sendMessage` returns provider-neutral `AgentRunOutcome`, including `requestedUserInput`.
- Manual DoD confirmation is stored as a governed `manual_dod` confirmation linked to self-driven Goal contracts, separate from Plan approval.
- Blocker audit fingerprints are reset on Runner start/resume and when progress advances, so stale blockers do not pollute a new attempt.
- Recoverable Runner blockers are audited by fingerprint and only enter `blocked` after 3 consecutive matching occurrences.
- Goal mode write scope now asks for scope expansion confirmation when a workspace write does not match path-like `inScope` boundaries and is not explicitly out-of-scope.
- Goal mode high-risk non-irreversible actions ask for a dedicated high-risk confirmation before execution.
- MCP provider permission requests classify tool effects as `mutation` or `read` from manifest `riskLevel`, so non-file side effects get comparable risk treatment in the PermissionGrant path.
- Goal UI has dedicated Manual DoD, blocker audit, verifier status strips, and separate high-risk / irreversible / scope-expansion confirmation cards.
- Goal confirmation requests are routed through local capability permission, not file permission, so Goal confirmations use the right PermissionGrant surface.
- Targeted tests cover self-driven Goal Evidence write, provider creation, Runner start, prompt sources, and goal-mode gates.

This document is a design proposal for making Peer Agent Goal mode behave like a combination of:

- Codex Goal mode: persistent objective ledger, budget/status accounting, blocker audit, and explicit completion/blocking semantics.
- Claude Code ultrathink workflow: autonomous inspect -> act -> verify loop, minimal interruptions, and evidence-backed completion.

This document intentionally avoids `docs/architecture/*`. Architecture impact is described here because repository rules treat architecture documents as read-only unless a specific architecture-document change is requested.

## Problem

Peer Agent currently has two names that look separated:

- `plan`: plan-before-execute, approval-gated.
- `goal`: self-driven objective mode.

The implementation is only partially separated.

Already aligned:

- Runtime Projection exposes execution tools in `goal` mode.
- `goal-mode-gate` does not impose a plan approval gate in `goal` mode.
- `goal-mode-gate` enforces workspace/out-of-scope write guards and irreversible-action confirmation before PermissionGrant.
- Goal Runner has no-progress protection, re-anchor, explorer dispatch, and verification gate foundations.
- Goal Runner context is injected through System Context sources rather than ad hoc prompt concatenation.

Before this implementation, the main gaps were:

- `goal_create_plan` still creates `awaiting_approval` plans in both Plan and Goal modes.
- Goal Runner start still requires `approval.decision === 'approve'` or an already-running status.
- `recordTaskEvidence` rejects `running`, `completed`, `failed`, and `waiting_user` before approval.
- The UI still shows approval cards in Goal mode.
- A Goal-mode conversation does not deterministically bootstrap a live objective contract before the agent starts working.

Without the landed slices, the result is a hybrid: Goal mode has self-driven tool access, but the persistent plan/task ledger still behaves like a Plan approval workflow.

## Target Semantics

```text
Chat mode
  User-led direct conversation.
  Tools are available as needed through Runtime Projection and PermissionGrant.

Plan mode
  User asks for work.
  Agent drafts a structured plan.
  User approves or rejects the plan.
  Approved plan is executed by Goal Runner using the same execution safeguards.

Goal mode
  User provides an objective and optional boundaries.
  Runtime accepts a GoalContract for this conversation.
  Agent autonomously drives inspect -> scaffold -> act -> verify -> repair until done.
  The agent interrupts only for ambiguity, product/business decisions, high-risk or irreversible actions, missing permission/credentials, scope drift, or verification conflict.
```

The important distinction:

```text
Plan centers on plan approval.
Goal centers on verified completion.
```

## Non-Negotiable Runtime Chain

All changes must preserve the repository governance chain:

```text
Capability Provider
  -> Manifest
    -> Runtime Projection
      -> Tool Call
        -> PermissionGrant
          -> Evidence
```

Goal mode must not add direct renderer execution, hidden shell/file paths, or assistant-text substitutes for Tool Result / Evidence.

## Proposed Protocol Additions

File: `packages/protocol/src/goal.ts`

Add workflow identity:

```ts
export type GoalWorkflowKind = 'plan_approval' | 'goal_self_driven';
```

Extend plan status:

```ts
export type GoalPlanStatus =
  | 'drafting'
  | 'awaiting_approval'
  | 'approved'
  | 'accepted'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';
```

`accepted` means the user objective has become an executable Goal contract. It is not the same as plan approval.

Add activation:

```ts
export interface GoalActivation {
  readonly kind: 'approval_required' | 'approved_plan' | 'accepted_goal';
  readonly sourceMessageId?: string;
  readonly acceptedAt?: string;
  readonly acceptedBy?: string;
}
```

Add execution policy:

```ts
export interface GoalExecutionPolicy {
  readonly autonomy: 'approval_gated' | 'self_driven';
  readonly irreversibleRequiresConfirmation: boolean;
  readonly writeScope: 'workspace_and_boundaries';
  readonly askUserOn: readonly (
    | 'ambiguous_goal'
    | 'product_decision'
    | 'high_risk'
    | 'irreversible'
    | 'missing_permission'
    | 'missing_credentials'
    | 'verification_conflict'
    | 'scope_drift'
  )[];
}
```

Add Runner phase:

```ts
export type GoalRunnerPhase =
  | 'orient'
  | 'inspect'
  | 'plan_scaffold'
  | 'act'
  | 'verify'
  | 'repair'
  | 'synthesize'
  | 'blocked';
```

Add blocker audit:

```ts
export interface GoalBlockerAudit {
  readonly fingerprint: string;
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly reason: string;
}
```

Extend `GoalPlan`:

```ts
readonly workflowKind?: GoalWorkflowKind;
readonly activation?: GoalActivation;
readonly executionPolicy?: GoalExecutionPolicy;
```

Extend `GoalRunnerState`:

```ts
readonly phase?: GoalRunnerPhase;
readonly blockerAudit?: GoalBlockerAudit;
readonly tokenBudget?: number;
readonly tokenUsed?: number;
```

Backward compatibility:

- Missing `workflowKind` means `plan_approval`.
- Missing `activation` on old approved/executing plans is normalized from current status and approval.
- Old `awaiting_approval` records must not be treated as Goal contracts.

## Store Design

File: `apps/desktop/electron/main/goal-plan-store.mjs`

Add helper:

```js
function isSelfDrivenGoal(plan) {
  return plan?.workflowKind === 'goal_self_driven'
    || plan?.executionPolicy?.autonomy === 'self_driven'
    || plan?.activation?.kind === 'accepted_goal';
}

function goalPlanRequiresApproval(plan) {
  return !isSelfDrivenGoal(plan);
}
```

Change `recordTaskEvidence`:

Current behavior:

```text
drafting / awaiting_approval cannot enter running / completed / failed / waiting_user
```

New behavior:

```text
Plan approval workflow:
  preserve current pre-approval denial.

Goal self-driven workflow:
  allow running / completed / failed / waiting_user once status is accepted or executing.
  still require real EvidenceRefs for completed.
```

Add API:

```js
function createGoalContract(draft = {}) {}
function upsertGoalContract(conversationId, draft = {}) {}
```

`createGoalContract` creates:

```js
{
  workflowKind: 'goal_self_driven',
  status: 'accepted',
  activation: {
    kind: 'accepted_goal',
    sourceMessageId,
    acceptedAt,
    acceptedBy: 'user',
  },
  executionPolicy: {
    autonomy: 'self_driven',
    irreversibleRequiresConfirmation: true,
    writeScope: 'workspace_and_boundaries',
    askUserOn: [
      'ambiguous_goal',
      'product_decision',
      'high_risk',
      'irreversible',
      'missing_permission',
      'missing_credentials',
      'verification_conflict',
      'scope_drift',
    ],
  },
}
```

`upsertGoalContract` should revise the active self-driven Goal in the same conversation rather than creating zombie plans.

Single-active-plan rule remains:

- A new Goal contract supersedes older active Goal contracts in the same conversation.
- A Plan approval draft and a Goal contract should not both be active for the same conversation unless explicitly supported later.

## Goal Provider Design

File: `apps/desktop/electron/main/runtime-gateway/local-goal-provider.mjs`

`goal_create_plan` must inspect `context.toolContext.mode`.

Plan mode:

```js
status: 'awaiting_approval'
workflowKind: 'plan_approval'
activation: { kind: 'approval_required' }
executionPolicy: { autonomy: 'approval_gated', ... }
```

Goal mode:

```js
status: 'accepted'
workflowKind: 'goal_self_driven'
activation: { kind: 'accepted_goal', sourceMessageId, acceptedAt }
executionPolicy: { autonomy: 'self_driven', ... }
```

Goal-mode tool result copy should say:

```text
Goal contract accepted. The runner may continue autonomously within the stated boundaries.
Use goal_update_task to write back evidence as work progresses.
```

It must not say:

```text
Plan created and awaiting approval.
```

`goal_update_task` must continue to write through the same provider and Evidence path.

## Deterministic Goal Bootstrap

Relying only on model behavior is not enough. Goal mode should create a minimal GoalContract deterministically from the user turn before model execution.

File: `apps/desktop/electron/main/llm-chat-service.mjs` or the `chat:send` orchestration in `main.mjs`.

Before building System Context for `mode === 'goal'`:

```js
goalPlanStore.ensureGoalContractForTurn({
  conversationId,
  sourceMessageId: latestUserMessageId,
  goal: latestUserContent,
  status: 'accepted',
  workflowKind: 'goal_self_driven',
});
```

This ensures:

- Goal Runner prompt source can see an active goal on the first turn.
- Boundary and DoD facts have a stable home even before the model calls `goal_create_plan`.
- The later model-created scaffold revises the same contract instead of creating a separate awaiting-approval plan.

The bootstrap contract may start with weak defaults:

```js
successCriteria: []
boundaries: { inScope: [], outOfScope: [] }
tasks: [
  {
    taskId: 'orient',
    title: 'Orient to the goal and establish a verifiable task scaffold',
    status: 'pending',
    evidenceRefs: [],
  }
]
```

The model can then revise it through `goal_create_plan` / a future `goal_revise_contract`.

## Runner Authorization

File: `apps/desktop/electron/main/goal-runner.mjs`

Replace `isStartAuthorized` with workflow-aware logic:

```js
function isStartAuthorized(plan) {
  if (!plan) return false;

  if (isSelfDrivenGoal(plan)) {
    return plan.activation?.kind === 'accepted_goal'
      || plan.status === 'accepted'
      || plan.status === 'executing'
      || plan.status === 'paused';
  }

  if (plan.approval?.decision === 'approve') return true;
  return plan.status === 'executing' || plan.status === 'paused';
}
```

When starting:

```text
accepted -> executing
approved -> executing
paused -> executing
```

Do not block self-driven Goals with `Goal Runner start blocked: plan is not approved`.

## Runner Loop Outcome

Current `runGoalTurn` does not return enough provider-neutral information and often returns `continue: false`, which makes the Runner idle after one tick.

Add a provider-neutral outcome from `llmChatService.sendMessage`:

```ts
interface AgentRunOutcome {
  terminalStatus: 'done' | 'error' | 'aborted';
  requestedUserInput: boolean;
  toolCallCount: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}
```

`request_user_input` already emits a control signal. The service should surface that signal as `requestedUserInput`.

Runner decision:

```text
requestedUserInput:
  pause or waiting_user, do not keep running.

terminalStatus = error:
  fail or retry depending on recoverability.

completed progress + verification gate passes:
  completed.

no progress repeated:
  blocker audit.

otherwise:
  continue next tick.
```

This is what turns the system from "one extra assistant turn" into a true autonomous Goal runner.

## Runner Phases

Runner should maintain a first-class `phase`:

```text
orient
  Parse objective, recover current contract, inspect existing plan state.

inspect
  Read files, search, use read-only tools and Explorer.

plan_scaffold
  Create or revise subtasks and DoD.

act
  Execute side-effecting changes through projected tools.

verify
  Run tests/checks/file assertions, record criterionResults.

repair
  Fix verification failures and re-run checks.

synthesize
  Summarize final evidence and mark complete.

blocked
  Stop after repeated same blocker or required user decision.
```

Phase is not just UI. It should be injected as factual runtime context and used by blocker fingerprints.

## Blocked Semantics

Codex-style blocker behavior should distinguish:

- transient difficulty,
- one failed attempt,
- true repeated blocker.

Add fingerprinting:

```js
function blockerFingerprint({ reason, phase, currentTaskId, missingPermission, verificationFailure }) {
  return stableHash({
    reason,
    phase,
    currentTaskId,
    missingPermission,
    verificationFailure,
  });
}
```

Audit rule:

```text
If the same blocker fingerprint occurs 3 consecutive Goal turns:
  status = blocked
  surface reason to user

If progress happens:
  reset blocker audit

If user resumes:
  reset blocker audit and begin a fresh audit window
```

No-progress can remain a special blocker fingerprint using completed count + leaf Evidence count.

## Evidence Registry

Current `goal_update_task` accepts arbitrary string refs. That is too weak for "Evidence owns factual accountability".

Add an Evidence registry in main process or data store:

```ts
interface EvidenceIndexRecord {
  readonly evidenceRef: string;
  readonly conversationId?: string;
  readonly streamId?: string;
  readonly toolCallId?: string;
  readonly capabilityId?: string;
  readonly toolName?: string;
  readonly createdAt: string;
  readonly artifactRefs?: readonly string[];
}
```

Every projected tool execution registers:

```text
tool-result://<toolCallId>
artifact refs emitted by the provider
local shell artifact refs
goal-create / goal-update refs
explorer refs
```

`recordTaskEvidence(status='completed')` should validate:

```text
At least one evidenceRef exists in EvidenceIndex for this conversation or plan.
```

Migration:

- Existing plans with arbitrary refs remain readable.
- New completions require indexed Evidence.
- If strict validation is too disruptive, begin with warning mode and flip to enforcement after tests pass.

## Completion Gate

Extend `evaluateVerificationGate`:

Required:

- all leaf tasks are `completed`,
- every completed leaf has indexed Evidence,
- all auto-verifiable criteria have `passed === true` and valid `evidenceRef`,
- no active failed Explorer result is unresolved,
- no active scope drift,
- no pending high-risk confirmation.

Manual DoD handling:

- If manual criteria exist, ask the user once at pre-finish.
- Do not ask for plan approval.
- Store the response as a governed confirmation linked to the Goal contract.

Current implementation:

- Self-driven Goal completion treats manual criteria as a hard pre-finish gate.
- Missing Manual DoD confirmation blocks Runner with `manual_dod_confirmation_required`.
- The renderer shows a dedicated Manual DoD confirmation card and writes `manual_dod` through IPC/store, not through Plan approval.

Completion should then set:

```text
plan.status = completed
runner.status = completed
runner.intent = synthesize
```

## Prompt Sources

Keep the existing direction:

- facts in `L7_CONTINUITY`,
- execution contract in `L6_MODE_REMINDER`,
- tool rules in `L5_TOOL_RULES`.

Required changes:

- Goal Runner source should render for `accepted` contracts.
- Contract text must stop saying "approved GoalPlan" for self-driven Goals.
- Mode reminder can keep saying self-driven, but it should mention GoalContract rather than internal plan approval.
- Compact summaries remain continuity only and must not replace Evidence refs or goal state.

Avoid:

- injecting tool output as system instructions,
- letting assistant text mark completion,
- duplicating approval semantics in Goal mode.

## UI Changes

Goal mode should not show the plan approval card.

Approval card condition:

```ts
plan.workflowKind === 'plan_approval'
  && plan.status === 'awaiting_approval'
```

Goal panel should show:

```text
Goal status: running / paused / blocked / completed
Phase: inspect / act / verify / repair
Current task
Progress
Evidence count
Verification status
Blocker reason
Controls: Pause, Resume, Stop
```

Goal mode user confirmations should be separate cards:

- high-risk action confirmation,
- irreversible action confirmation,
- manual DoD confirmation,
- scope expansion confirmation.

These are not "Approve plan" cards.

## Runtime Gate

Keep current direction in `goal-mode-gate.mjs`:

Plan:

```text
side effects blocked until approved
```

Goal:

```text
no plan approval gate
workspace/outOfScope write guard
high-risk action confirmation
irreversible action confirmation
normal PermissionGrant remains
```

Add:

- provider/MCP mutation classification so non-file side effects get comparable risk treatment,
- explicit test coverage for MCP mutation tools in Goal mode.

Landed:

- scope expansion confirmation when a write target is not clearly in-scope but not explicitly out-of-scope.
- provider/MCP permission requests carry `scope.effect = mutation | read` and manifest-derived risk/data levels.
- integration tests cover default MCP mutation classification and read-only MCP classification.
- scope/high-risk/irreversible Goal confirmations route through local capability permission instead of the file-permission requester.
- high-risk, irreversible, and scope-expansion Goal confirmations render as distinct PermissionGrant cards.

## Implementation Slices

### Slice 1: Protocol and normalization

Status: landed.

- Add workflow fields and statuses.
- Normalize missing `workflowKind` to `plan_approval`.
- Add store helpers `goalPlanIsSelfDriven` and `goalPlanRequiresApproval`.
- Tests for old plan compatibility.

### Slice 2: Goal contract creation

Status: landed for `createGoalContract`, `upsertGoalContract`, provider branching, and IPC bootstrap.

- Add `createGoalContract` and `upsertGoalContract`.
- Change `goal_create_plan` to branch on mode.
- Add deterministic Goal bootstrap before first Goal-mode model call.
- Tests for Goal contract status `accepted`.

### Slice 3: Runner authorization and continuation

Status: landed for runner authorization, provider-neutral run outcome, and request-user-input stop semantics.

- Make `isStartAuthorized` workflow-aware.
- Add `accepted -> executing` transition.
- Make Goal Runner continue until completion/blocker/user input rather than one tick.
- Return provider-neutral `AgentRunOutcome` from `sendMessage`.

### Slice 4: Evidence registry

Status: landed for projected tool registration, task completion validation, and criterion evidence validation.

- Register projected tool Evidence refs.
- Validate completion refs in `recordTaskEvidence`.
- Add warning mode first if necessary.
- Tests for arbitrary fake evidence rejection.

### Slice 5: Verification and blocker semantics

Status: landed for indexed Evidence checks, Manual DoD confirmation, blocker fingerprint thresholding, blocker-audit reset, and existing no-progress protection.

- Extend verification gate.
- Add blocker fingerprint audit.
- Reset audit on progress and resume.
- Add manual DoD confirmation path.

### Slice 6: UI alignment

Status: landed for `accepted` status labeling, no approval card for accepted contracts, dedicated Manual DoD confirmation, blocker audit, verifier status strips, and distinct high-risk / irreversible / scope-expansion confirmation cards.

- Hide approval card for self-driven Goal.
- Add phase/status display.
- Add blocker and verification display.
- Keep renderer as presentation only; all truth remains in main/store.

### Slice 7: Test migration

Status: landed for store/provider/runner/prompt/gate coverage and Goal confirmation card classification.

Update old tests that protect plan-only semantics:

- "unapproved plan cannot start runner" remains true for `plan_approval`.
- New test: accepted self-driven Goal can start runner without approval.
- New test: accepted self-driven Goal can record running/completed with valid Evidence.
- New test: Goal irreversible action asks confirmation.
- New test: Goal high-risk action asks confirmation.
- New test: Goal high-risk / irreversible / scope-expansion confirmations render as distinct cards.
- New test: Goal out-of-scope write is denied.
- New test: same blocker repeats 3 times before blocked. Landed.
- New test: Goal UI does not show approval card.

## Acceptance Criteria

Goal mode is aligned when all of these are true:

1. Starting a Goal-mode conversation creates or accepts a GoalContract without a plan approval step.
2. Goal Runner starts from that contract without `approval.decision === 'approve'`.
3. Plan mode still blocks side-effecting tools until approval.
4. Goal mode can execute side-effecting tools through Runtime Projection, PermissionGrant, and Evidence.
5. Goal mode cannot write outside workspace or explicit boundaries.
6. High-risk and irreversible actions require confirmation.
7. Task completion requires indexed Evidence.
8. Final completion requires verification gate success.
9. Goal confirmations render as Goal-specific cards, not Plan approval cards.
9. Manual DoD asks the user once at pre-finish, not as plan approval.
10. Repeated same blocker becomes blocked only after the configured audit threshold.
11. UI distinguishes Goal running/blocker cards from Plan approval cards.

## Open Decisions

1. Should deterministic Goal bootstrap happen in `llm-chat-service.sendMessage` or in `main.mjs` before calling it?
   - Prefer `llm-chat-service` if prompt assembly and runtime tools both need the same contract.
   - Prefer `main.mjs` if conversation mutation ownership should stay at the IPC boundary.

2. Should `goal_create_plan` revise the active contract or should we introduce `goal_revise_contract`?
   - Prefer revising through `goal_create_plan` initially to reduce tool surface.
   - Add `goal_revise_contract` later if prompt clarity suffers.

3. Should Evidence registry enforce immediately or start as warning mode?
   - Prefer warning mode for one release if there are many historical refs.
   - Enforce for new `goal_self_driven` plans as soon as tests cover all built-in tools.

4. Should token budget be enforced or only displayed?
   - Codex Goal has explicit budget/accounting semantics.
   - Current Runner removed hard budget exhaustion. Reintroduce budget only as a soft warning unless the user explicitly sets a hard budget.

## Architecture Impact

This is an A-level change:

- runtime contracts change,
- permission and execution admission semantics change,
- Evidence validation gets stronger,
- System Context sources must reflect GoalContract facts,
- UI approval semantics change.

The implementation must preserve the 端云能力代理设计原则:

```text
云端负责认知。
本地负责能力。
界面负责表达。
契约负责边界。
证据负责治理。
```

The desktop client still owns local discovery, local authorization, local execution, and Evidence return. Renderer remains presentation only. Protocol owns contracts. Evidence remains the factual accountability layer.
