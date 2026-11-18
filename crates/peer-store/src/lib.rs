#![forbid(unsafe_code)]

mod approvals;
mod coordination;
mod coordination_fence;
pub use coordination::{CoordinationError, CoordinationSnapshot, CoordinationStore};
mod durable_jsonl;
mod tool_artifacts;
mod web_artifacts;
pub use tool_artifacts::{
    ToolArtifactError, ToolArtifactFormat, ToolArtifactRef, ToolArtifactStore, ToolArtifactWindow,
};
pub use web_artifacts::{WebArtifactError, WebArtifactPublication, WebArtifactStore};
mod evidence;
mod files;
mod model_config;
pub use approvals::{ApprovalDecision, ApprovalState, ApprovalStore, HostApproval};
pub use evidence::{EvidenceIndexStore, HostToolEvidence};
pub use model_config::{ModelConfigSnapshot, ModelConfigStore, ModelConfigTransaction};
mod interactive_result;
mod resources;
mod shell_artifacts;
mod sqlite_file;
#[cfg(feature = "test-fixtures")]
pub use coordination_fence::protect_coordination_writer_fixture;
pub use coordination_fence::{FenceError, FenceOutcome, FenceStep, protect_coordination_writer};
pub use interactive_result::{InteractiveReadError, read_interactive_result};
pub use resources::{
    ExecutionResourceStore, HostClaimClosure, HostDispatchScopes, HostFileMaterialization,
    HostResourcePlan, ResourceError, ResourceIdentity, ResourceReservation, directory_resource,
    file_resource, provider_execution_scopes, provider_file_scopes, resource_conflicts,
};
pub use shell_artifacts::ShellArtifacts;
mod context_accounting;
mod mcp_inventory;
pub use mcp_inventory::{McpRegistrySnapshot, McpRegistryStore};
mod mcp_credentials;
pub use mcp_credentials::{McpCredentialBinding, McpCredentialStore, McpCredentialTransaction};
mod conversation_execution;
mod conversation_preview;
mod conversation_terminal;
mod conversation_write;
pub use context_accounting::context_model_key;
pub use conversation_execution::{
    ConversationClaimFailure, ConversationExecutionToken, ConversationHookRecord,
    ConversationMetadataPublication, ConversationRecovery, ConversationUsageReceipt,
    EmptyConversationClaim, NewConversationExecution, conversation_hook_observation,
    conversation_hook_process,
};
mod goal;
mod goal_source;
pub use goal::{
    AutomaticInspect, EXPLORER_TIMEOUT_MS, EXPLORER_TOOL_LIMIT, ExplorerDispatch, ExplorerLease,
    ExplorerSettlement, GoalError, GoalExecutionFact, GoalMirrorCommit, GoalMirrorTransaction,
    GoalPublication, GoalSelection, GoalSnapshot, GoalStore, GoalTaskPublication, LocalGoalIntake,
    OrdinaryGoalDraft, OrdinaryGoalKind, OrdinaryRunner, RunnerAdmission, RunnerPhase, RunnerStop,
    VerifierLease, VerifierReceipt, VerifierSettlement,
};
mod history;
mod hook_config;
pub use hook_config::{HookConfig, HookDefinition, HookPhase};
mod presentation;
pub use presentation::{DisplayEvent, DisplayReadError, DisplaySnapshot, SessionMetadata};
mod usage_ledger;
pub use conversation_write::{ConversationModelSelection, MessageCommit, NewConversation};
mod lease;
mod lock;
mod policy;
mod skill_catalog;
pub use skill_catalog::{MountedSkill, SkillCatalog, SkillScope};
mod skill_manifest;
pub use skill_manifest::SkillManifest;
mod transcript;
pub use transcript::{TranscriptError, TranscriptLimit, TranscriptLimits, TranscriptReader};

pub(crate) use files::identity;
pub use goal_source::{GoalSourceSnapshot, GoalSourceStore};
pub use history::{ConversationMetadataSnapshot, ConversationStore, HistorySnapshot};
pub use lease::{
    AcquireLease, HOST_LEASE_HEARTBEAT_MS, HOST_LEASE_STALE_MS, HostIdentity, HostLeaseRecord,
    HostLeaseStore, HostSurface, LeaseToken,
};
pub use lock::DirectoryLock;
pub use policy::{PolicyInitialization, PolicyStore, PolicyUpdateError};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    ExecutionInvalid,
    ExecutionBusy,
    ExecutionChanged,
    McpCredentialInvalid,
    McpCredentialMigrationRequired,
    McpCredentialMissing,
    McpInventoryInvalid,
    ContextInvalid,
    ContextConflict,
    ContextCommitUncertain,
    UsageInvalid,
    UsageLimit,
    UsageConflict,
    UsageCommitUncertain,
    InvalidInput,
    CommitUncertain,
    ApprovalConflict,
    ApprovalCorrupt,
    EvidenceInvalid,
    EvidenceUnsupported,
    NotFound,
    OutOfScope,
    VersionChanged,
    HistoryLimit,
    HistoryCorrupt,
    HistoryMissing,
    StreamStateInvalid,
    StreamTargetMissing,
    ReadFailed,
    PolicyUnavailable,
    PolicyLimit,
    GoalLimit,
    GoalCorrupt,
    GoalChanged,
    LockBusy,
    LockOwnershipChanged,
    Cancelled,
    LeaseCorrupt,
    LeaseOwnershipLost,
    LeaseContended,
}

impl StoreError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ExecutionInvalid => "conversation_execution_invalid",
            Self::ExecutionBusy => "conversation_execution_busy",
            Self::ExecutionChanged => "conversation_execution_changed",
            Self::McpCredentialInvalid => "mcp_credential_invalid",
            Self::McpCredentialMigrationRequired => "mcp_credential_migration_required",
            Self::McpCredentialMissing => "mcp_credential_missing",
            Self::McpInventoryInvalid => "MCP_INVENTORY_INVALID",
            Self::ContextInvalid => "CONTEXT_SNAPSHOT_INVALID",
            Self::ContextConflict => "CONTEXT_SNAPSHOT_CHANGED",
            Self::ContextCommitUncertain => "CONTEXT_SNAPSHOT_COMMIT_UNCERTAIN",
            Self::UsageInvalid => "USAGE_LEDGER_INVALID",
            Self::UsageLimit => "USAGE_LEDGER_LIMIT",
            Self::UsageConflict => "USAGE_LEDGER_CONFLICT",
            Self::UsageCommitUncertain => "USAGE_LEDGER_COMMIT_UNCERTAIN",
            Self::InvalidInput => "INVALID_INPUT",
            Self::CommitUncertain => "STORE_COMMIT_UNCERTAIN",
            Self::ApprovalConflict => "APPROVAL_STATE_CHANGED",
            Self::ApprovalCorrupt => "APPROVAL_STORE_INVALID",
            Self::EvidenceInvalid => "EVIDENCE_RECORD_INVALID",
            Self::EvidenceUnsupported => "EVIDENCE_ADAPTER_UNSUPPORTED",
            Self::NotFound => "NOT_FOUND",
            Self::OutOfScope => "OUT_OF_SCOPE",
            Self::VersionChanged => "BACKGROUND_VERSION_CHANGED",
            Self::HistoryLimit => "BACKGROUND_HISTORY_LIMIT",
            Self::HistoryCorrupt => "BACKGROUND_HISTORY_CORRUPT",
            Self::HistoryMissing => "BACKGROUND_HISTORY_MISSING",
            Self::StreamStateInvalid => "BACKGROUND_STREAM_STATE_INVALID",
            Self::StreamTargetMissing => "BACKGROUND_STREAM_TARGET_MISSING",
            Self::ReadFailed => "BACKGROUND_READ_FAILED",
            Self::PolicyUnavailable => "POLICY_UNAVAILABLE",
            Self::PolicyLimit => "POLICY_RESOURCE_LIMIT",
            Self::GoalLimit => "GOAL_SOURCE_LIMIT",
            Self::GoalCorrupt => "GOAL_SOURCE_INVALID",
            Self::GoalChanged => "GOAL_SOURCE_CHANGED",
            Self::LockBusy => "STORE_LOCK_BUSY",
            Self::LockOwnershipChanged => "STORE_LOCK_OWNERSHIP_CHANGED",
            Self::Cancelled => "CANCELLED",
            Self::LeaseCorrupt => "CORRUPT_LEASE",
            Self::LeaseOwnershipLost => "HOST_LEASE_LOST",
            Self::LeaseContended => "HOST_LEASE_CONTENDED",
        }
    }
}
impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for StoreError {}

fn valid_id(id: &str, workspace: bool) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, b'_' | b'-')
                || workspace && matches!(c, b'.' | b':')
        })
}
