#![forbid(unsafe_code)]

mod bounded_json;
mod permission_digest;
mod store;

pub use bounded_json::{DecodedJson, JsonDecodeError, JsonLimits, decode_json_bounded};
pub use permission_digest::{DigestError, approval_args_digest};
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
pub fn data_home_with(mut lookup: impl FnMut(&str) -> Option<String>, home: PathBuf) -> PathBuf {
    for key in ["PEER_AGENT_HOME", "PEER_USER_DATA_PATH"] {
        if let Some(value) = lookup(key).filter(|value| !value.trim().is_empty()) {
            return PathBuf::from(value.trim());
        }
    }
    home.join(".peer-agent")
}

pub fn data_home() -> Option<PathBuf> {
    let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"))?;
    Some(data_home_with(|key| env::var(key).ok(), home.into()))
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
