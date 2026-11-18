//! Shared native capability vocabulary. No Goal, conversation or UI owns
//! permission classification; these types never constitute a grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilityError(pub &'static str);
impl std::fmt::Display for CapabilityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for CapabilityError {}
impl From<peer_store::StoreError> for CapabilityError {
    fn from(e: peer_store::StoreError) -> Self {
        Self(e.code())
    }
}
impl From<peer_store::GoalError> for CapabilityError {
    fn from(e: peer_store::GoalError) -> Self {
        Self(e.code())
    }
}
impl From<peer_store::CoordinationError> for CapabilityError {
    fn from(e: peer_store::CoordinationError) -> Self {
        Self(e.code())
    }
}
impl From<peer_store::ResourceError> for CapabilityError {
    fn from(e: peer_store::ResourceError) -> Self {
        Self(e.code())
    }
}
/// Trusted Provider manifest classification, never deserialized from call args.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ProviderPermission {
    Read,
    ConversationGoal,
    UserInput,
    FileWrite,
    Shell,
    ShellStop,
    Mcp,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ShellRisk {
    Inert,
    LocalRead,
    LocalWrite,
    ExternalWrite,
    Privileged,
    Destructive,
}
impl ShellRisk {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Inert => "L0_inert",
            Self::LocalRead => "L1_local_read",
            Self::LocalWrite => "L2_local_write",
            Self::ExternalWrite => "L3_external_write",
            Self::Privileged => "L4_privileged",
            Self::Destructive => "L5_destructive",
        }
    }
}

/// Classification only; a Host still owns current execution/permission checks.
pub(crate) fn read_capability(capability: &str) -> bool {
    matches!(
        capability,
        "local.file.read"
            | "local.tool-result.read"
            | "local.file.list"
            | "local.file.search"
            | "local.search.aggregate"
            | "local.image.read"
            | "local.git.query"
    )
}

pub(crate) fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(
            &time::format_description::parse_borrowed::<2>(
                "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z",
            )
            .expect("timestamp format"),
        )
        .expect("UTC timestamp")
}

pub(crate) fn milliseconds(now: &str) -> Result<i64, CapabilityError> {
    let at = time::OffsetDateTime::parse(now, &time::format_description::well_known::Rfc3339)
        .map_err(|_| CapabilityError("invalid_host_time"))?;
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| CapabilityError("invalid_host_time"))
}
