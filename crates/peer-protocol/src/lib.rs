#![forbid(unsafe_code)]

mod evidence_refs;
mod execution_identity;
pub use evidence_refs::{EvidenceRefError, collect_tool_evidence_refs, javascript_trim};
pub use execution_identity::{
    ExecutionResourceScope, SessionExecutionIdentity, normalize_execution_resource_scope,
    normalize_session_execution_identity,
};

mod bounded_json;
mod permission_digest;
mod store;

pub use bounded_json::{DecodedJson, JsonDecodeError, JsonLimits, decode_json_bounded};
pub use permission_digest::{
    DigestError, PermissionOperation, approval_args_digest, javascript_json_digest,
    javascript_json_string, permission_operation_key,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{env, path::PathBuf};
pub use store::{BotAccessPolicy, LocalAccessLevel, PersistedHistory};

pub const CONTRACT_JSON: &str =
    include_str!("../../../packages/protocol/contracts/native-cli/v1.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum CliExit {
    Ok = 0,
    Runtime = 1,
    Usage = 2,
    Auth = 3,
    Cancelled = 4,
    MaxTurns = 5,
    WaitingUser = 6,
    GoalFailed = 7,
    BotReplyPending = 8,
}

pub fn contract_hash() -> String {
    format!("{:x}", Sha256::digest(CONTRACT_JSON.as_bytes()))
}

/// Resolve only; discovery never creates or migrates a user data root.
fn data_home_override(lookup: &mut impl FnMut(&str) -> Option<String>) -> Option<PathBuf> {
    for key in ["PEER_AGENT_HOME", "PEER_USER_DATA_PATH"] {
        if let Some(value) = lookup(key).filter(|value| !javascript_trim(value).is_empty()) {
            return Some(PathBuf::from(javascript_trim(&value)));
        }
    }
    None
}
pub fn data_home_with(mut lookup: impl FnMut(&str) -> Option<String>, home: PathBuf) -> PathBuf {
    data_home_override(&mut lookup).unwrap_or_else(|| home.join(".peer-agent"))
}

pub fn data_home() -> Option<PathBuf> {
    if let Some(path) = data_home_override(&mut |key| env::var(key).ok()) {
        return Some(path);
    }
    let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".peer-agent"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn shared_contract_has_supported_version_and_legacy_exit_codes() {
        let contract: Value = serde_json::from_str(CONTRACT_JSON).unwrap();
        assert_eq!(contract["version"], 1);
        for (name, code) in [
            ("ok", CliExit::Ok),
            ("runtime", CliExit::Runtime),
            ("usage", CliExit::Usage),
            ("auth", CliExit::Auth),
            ("cancelled", CliExit::Cancelled),
            ("maxTurns", CliExit::MaxTurns),
            ("waitingUser", CliExit::WaitingUser),
            ("goalFailed", CliExit::GoalFailed),
            ("botReplyPending", CliExit::BotReplyPending),
        ] {
            assert_eq!(contract["exitCodes"][name], json!(code as u8));
        }
    }

    #[test]
    fn data_root_matches_typescript_vectors_without_mutation() {
        let contract: Value = serde_json::from_str(CONTRACT_JSON).unwrap();
        for case in contract["dataHomeCases"].as_array().unwrap() {
            let actual = data_home_with(
                |key| case["env"][key].as_str().map(str::to_owned),
                PathBuf::from(case["home"].as_str().unwrap()),
            );
            assert_eq!(actual.to_str().unwrap(), case["expected"].as_str().unwrap());
        }
    }
}

mod lease;
pub use lease::{HostLeaseRecord, HostSurface};
