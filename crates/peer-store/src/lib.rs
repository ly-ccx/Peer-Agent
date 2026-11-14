#![forbid(unsafe_code)]

mod files;
mod goal_source;
mod history;
mod lease;
mod lock;
mod policy;
mod transcript;
pub use transcript::{TranscriptError, TranscriptLimit, TranscriptLimits, TranscriptReader};

pub(crate) use files::identity;
pub use goal_source::{GoalSourceSnapshot, GoalSourceStore};
pub use history::{ConversationStore, HistorySnapshot};
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
