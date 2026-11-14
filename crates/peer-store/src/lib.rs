#![forbid(unsafe_code)]

mod approvals;
mod coordination;
mod coordination_fence;
pub use coordination::{CoordinationError, CoordinationSnapshot, CoordinationStore};
mod durable_jsonl;
mod evidence;
mod files;
pub use approvals::{ApprovalDecision, ApprovalState, ApprovalStore, HostApproval};
pub use evidence::{EvidenceIndexStore, HostToolEvidence};
mod resources;
mod sqlite_file;
#[cfg(feature = "test-fixtures")]
pub use coordination_fence::protect_coordination_writer_fixture;
pub use coordination_fence::{FenceError, FenceOutcome, FenceStep, protect_coordination_writer};
pub use resources::{
    ExecutionResourceStore, HostClaimClosure, HostDispatchScopes, HostResourcePlan, ResourceError,
    ResourceIdentity, ResourceReservation, directory_resource, file_resource,
    provider_execution_scopes, provider_file_scopes, resource_conflicts,
};
mod conversation_preview;
mod conversation_write;
mod goal;
mod goal_source;
pub use goal::{GoalError, GoalSelection, GoalSnapshot, GoalStore};
mod history;
pub use conversation_write::{MessageCommit, NewConversation};
mod lease;
mod lock;
mod policy;
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
