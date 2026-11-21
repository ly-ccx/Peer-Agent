//! Bot profile store: canonical source of truth is `projects/<workspaceId>/profile.json`.
//!
//! Matches `packages/runtime-node/src/project-agent/bot-profile-store.mjs` and
//! `packages/protocol/src/project.ts` (ADR 84, ADR 85 §7). Unknown fields are
//! preserved via `extra` so TS/Rust round-trips never strip future metadata.

use crate::{ProjectError, atomic_write, fnv1a_utf16, is_valid_workspace_id, now_iso};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

const NAME_MAX: usize = 40;
const MAX_PROFILE_BYTES: u64 = 2 * 1024 * 1024;

pub const BOT_AVATAR_SHAPES: [&str; 8] = [
    "circle", "square", "triangle", "diamond", "hex", "pill", "star", "arch",
];

pub const BOT_AVATAR_COLORS: [&str; 8] = [
    "#6474e5", "#f36d63", "#f4ad45", "#61b68c", "#a884e5", "#e774ad", "#55bac7", "#a8a59f",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BotAvatar {
    Generated {
        shape: String,
        color: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        variant: Option<u32>,
    },
    Image {
        #[serde(rename = "ref")]
        image_ref: String,
    },
}

/// Deterministic avatar generator matching `packages/protocol/src/project.ts#generateAvatar`.
pub fn generate_avatar(key: &str) -> BotAvatar {
    let hash = fnv1a_utf16(key);
    let shape = BOT_AVATAR_SHAPES[(hash as usize) % BOT_AVATAR_SHAPES.len()].to_owned();
    let color = BOT_AVATAR_COLORS[((hash >> 16) as usize) % BOT_AVATAR_COLORS.len()].to_owned();
    let variant = (hash >> 8) % 32;
    BotAvatar::Generated {
        shape,
        color,
        variant: Some(variant),
    }
}

/// Strip control characters, bidi controls, and path separators; cap at 40 Unicode scalars.
pub fn clean_display_name(value: &str) -> String {
    let stripped: String = value
        .chars()
        .filter(|&c| {
            let code = c as u32;
            !((code <= 0x1f || code == 0x7f)
                || c == '/'
                || c == '\\'
                || (0x200b..=0x200f).contains(&code)
                || (0x202a..=0x202e).contains(&code))
        })
        .collect();
    let trimmed = stripped.trim().trim_end_matches(['.', ' ']).trim();
    trimmed.chars().take(NAME_MAX).collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotProfile {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub workspace_id: String,
    pub display_name: String,
    pub avatar: BotAvatar,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_salt: Option<String>,
    #[serde(default)]
    pub managed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proactivity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_approval: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance_policy: Option<String>,
    #[serde(default)]
    pub auto_handoff_on_policy_accept: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_policy: Option<Value>,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme_offer: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub familiarize: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unknown_outcome_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletion_cleanup: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_schema_version() -> u32 {
    1
}

fn default_status() -> String {
    "active".to_owned()
}

impl BotProfile {
    pub fn is_active(&self) -> bool {
        self.status == "active"
    }

    pub fn is_memory_enabled(&self) -> bool {
        self.memory_enabled != Some(false)
    }

    pub fn acceptance_policy_str(&self) -> &str {
        if self.acceptance_policy.as_deref() == Some("confirm") {
            "confirm"
        } else {
            "auto"
        }
    }

    pub fn plan_approval_str(&self) -> &str {
        match self.plan_approval.as_deref() {
            Some("always") => "always",
            Some("writes") => "writes",
            _ => "never",
        }
    }
}

pub struct CreateBotProfile<'a> {
    pub workspace_id: &'a str,
    pub display_name: &'a str,
    pub managed: bool,
    pub agent_conversation_id: &'a str,
    pub avatar_salt: &'a str,
}

pub struct BotProfileStore {
    projects_dir: PathBuf,
}

fn generated_signature(avatar: &BotAvatar, workspace_id: &str) -> Option<String> {
    let BotAvatar::Generated {
        shape,
        color,
        variant,
    } = avatar
    else {
        return None;
    };
    let v = variant.unwrap_or_else(|| match generate_avatar(workspace_id) {
        BotAvatar::Generated { variant, .. } => variant.unwrap_or(0),
        BotAvatar::Image { .. } => 0,
    });
    Some(format!("{shape}:{color}:{v}"))
}

impl BotProfileStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            projects_dir: data_home.as_ref().join("projects"),
        }
    }

    fn profile_file(&self, workspace_id: &str) -> PathBuf {
        self.projects_dir.join(workspace_id).join("profile.json")
    }

    pub fn list_workspace_ids(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(&self.projects_dir) else {
            return Vec::new();
        };
        let mut ids = Vec::new();
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str()
                && is_valid_workspace_id(name)
            {
                ids.push(name.to_owned());
            }
        }
        ids.sort();
        ids
    }

    pub fn read(&self, workspace_id: &str) -> Option<BotProfile> {
        if !is_valid_workspace_id(workspace_id) {
            return None;
        }
        let target = self.profile_file(workspace_id);
        let meta = fs::metadata(&target).ok()?;
        if !meta.is_file() || meta.len() > MAX_PROFILE_BYTES {
            return None;
        }
        let raw = fs::read_to_string(&target).ok()?;
        let parsed: BotProfile = serde_json::from_str(&raw).ok()?;
        if parsed.workspace_id != workspace_id || parsed.display_name.is_empty() {
            return None;
        }
        Some(parsed)
    }

    fn occupied_avatars(&self, except_workspace_id: &str) -> HashSet<String> {
        let mut occupied = HashSet::new();
        for id in self.list_workspace_ids() {
            if id == except_workspace_id {
                continue;
            }
            if let Some(profile) = self.read(&id)
                && profile.status != "archived"
                && let Some(sig) = generated_signature(&profile.avatar, &id)
            {
                occupied.insert(sig);
            }
        }
        occupied
    }

    fn choose_generated_avatar(
        &self,
        workspace_id: &str,
        start_salt: &str,
    ) -> Option<(BotAvatar, String)> {
        let occupied = self.occupied_avatars(workspace_id);
        let start = start_salt.parse::<u64>().unwrap_or(0);
        for numeric_salt in (start..).take(2048) {
            let salt = if numeric_salt == 0 {
                String::new()
            } else {
                numeric_salt.to_string()
            };
            let key = if salt.is_empty() {
                workspace_id.to_owned()
            } else {
                format!("{workspace_id}:{salt}")
            };
            let avatar = generate_avatar(&key);
            if let Some(sig) = generated_signature(&avatar, workspace_id)
                && !occupied.contains(&sig)
            {
                return Some((avatar, salt));
            }
        }
        None
    }

    fn write(&self, profile: &BotProfile) -> Result<BotProfile, ProjectError> {
        let mut body = serde_json::to_string_pretty(profile)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        body.push('\n');
        atomic_write(&self.profile_file(&profile.workspace_id), body.as_bytes())?;
        Ok(profile.clone())
    }

    /// Create a bot profile idempotently. Returns `(profile, created)`.
    pub fn create(&self, input: &CreateBotProfile<'_>) -> Result<(BotProfile, bool), ProjectError> {
        if !is_valid_workspace_id(input.workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        let name = clean_display_name(input.display_name);
        if name.is_empty() {
            return Err(ProjectError::code("INVALID_NAME"));
        }
        let conv = input.agent_conversation_id.trim();
        if conv.is_empty() {
            return Err(ProjectError::code("CONVERSATION_REQUIRED"));
        }
        if let Some(existing) = self.read(input.workspace_id) {
            return Ok((existing, false));
        }
        let (avatar, avatar_salt) = self
            .choose_generated_avatar(input.workspace_id, input.avatar_salt)
            .ok_or_else(|| ProjectError::code("AVATAR_EXHAUSTED"))?;
        let at = now_iso();
        let profile = BotProfile {
            schema_version: 1,
            workspace_id: input.workspace_id.to_owned(),
            display_name: name,
            avatar,
            avatar_salt: Some(avatar_salt),
            managed: input.managed,
            agent_conversation_id: Some(conv.to_owned()),
            proactivity: Some("inherit".to_owned()),
            memory_enabled: None,
            plan_approval: None,
            acceptance_policy: None,
            auto_handoff_on_policy_accept: false,
            model_policy: None,
            status: "active".to_owned(),
            readme_offer: None,
            familiarize: None,
            unknown_outcome_policy: None,
            deletion_cleanup: None,
            created_at: Some(at.clone()),
            updated_at: Some(at),
            extra: Map::new(),
        };
        Ok((self.write(&profile)?, true))
    }

    /// Persist updates to an existing bot profile, preserving immutable `createdAt`.
    pub fn save(&self, mut next: BotProfile) -> Result<BotProfile, ProjectError> {
        if !is_valid_workspace_id(&next.workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        let current = self
            .read(&next.workspace_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let name = clean_display_name(&next.display_name);
        if name.is_empty() {
            return Err(ProjectError::code("INVALID_NAME"));
        }
        next.display_name = name;
        next.created_at = current.created_at.or(next.created_at);
        next.updated_at = Some(now_iso());
        self.write(&next)
    }

    pub fn set_proactivity(
        &self,
        workspace_id: &str,
        level: &str,
    ) -> Result<BotProfile, ProjectError> {
        if !matches!(
            level,
            "inherit" | "quiet" | "low" | "standard" | "high" | "muted"
        ) {
            return Err(ProjectError::code("INVALID_PROACTIVITY"));
        }
        let mut profile = self
            .read(workspace_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        profile.proactivity = Some(level.to_owned());
        self.save(profile)
    }

    pub fn archive(&self, workspace_id: &str) -> Result<BotProfile, ProjectError> {
        let mut profile = self
            .read(workspace_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        profile.status = "archived".to_owned();
        self.save(profile)
    }

    /// Read per-bot unknown-outcome policy (`ask` by default); reject corrupt/unsupported tiers.
    pub fn read_unknown_outcome_policy(&self, workspace_id: &str) -> Result<Value, ProjectError> {
        let profile = self
            .read(workspace_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let binding_conv = profile
            .agent_conversation_id
            .as_deref()
            .map(|c| serde_json::json!(c))
            .unwrap_or(Value::Null);
        match profile.unknown_outcome_policy.as_ref() {
            None | Some(Value::Null) => Ok(serde_json::json!({
                "workspaceId": workspace_id,
                "agentConversationId": binding_conv,
                "tier": "ask",
            })),
            Some(stored) => {
                let tier = stored["tier"]
                    .as_str()
                    .filter(|t| matches!(*t, "ask" | "bot_verified"))
                    .ok_or_else(|| ProjectError::code("UNKNOWN_OUTCOME_POLICY_UNSUPPORTED"))?;
                let policy_id = stored["policyId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| ProjectError::code("UNKNOWN_OUTCOME_POLICY_UNSUPPORTED"))?;
                let revision = stored["revision"]
                    .as_u64()
                    .filter(|r| *r >= 1)
                    .ok_or_else(|| ProjectError::code("UNKNOWN_OUTCOME_POLICY_UNSUPPORTED"))?;
                let updated_at = stored["updatedAt"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| ProjectError::code("UNKNOWN_OUTCOME_POLICY_UNSUPPORTED"))?;
                let mut out = serde_json::json!({
                    "workspaceId": workspace_id,
                    "agentConversationId": binding_conv,
                    "tier": tier,
                    "policyId": policy_id,
                    "revision": revision,
                    "updatedAt": updated_at,
                });
                if let Some(delegated_at) = stored["delegatedAt"].as_str().filter(|s| !s.is_empty())
                {
                    out["delegatedAt"] = Value::String(delegated_at.to_owned());
                }
                Ok(out)
            }
        }
    }

    /// Update per-bot unknown-outcome policy (`ask` | `bot_verified`). Stamps `delegatedAt`
    /// when delegating (`ask` -> `bot_verified`) and preserves `policyId` across revisions.
    pub fn set_unknown_outcome_policy(
        &self,
        workspace_id: &str,
        tier: &str,
    ) -> Result<Value, ProjectError> {
        if !matches!(tier, "ask" | "bot_verified") {
            return Err(ProjectError::code("INVALID_UNKNOWN_OUTCOME_TIER"));
        }
        let mut current = self
            .read(workspace_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let stored = current
            .unknown_outcome_policy
            .as_ref()
            .filter(|v| !v.is_null());
        if let Some(existing) = stored
            && !existing["tier"]
                .as_str()
                .is_some_and(|t| matches!(t, "ask" | "bot_verified"))
        {
            return Err(ProjectError::code("UNKNOWN_OUTCOME_POLICY_UNSUPPORTED"));
        }
        let stored_tier = stored.and_then(|v| v["tier"].as_str());
        let at = now_iso();
        let delegated_at = if stored_tier != Some("bot_verified") && tier == "bot_verified" {
            Some(at.clone())
        } else {
            stored
                .and_then(|v| v["delegatedAt"].as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let policy_id = stored
            .and_then(|v| v["policyId"].as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("policy-{}", uuid::Uuid::new_v4()));
        let revision = stored.and_then(|v| v["revision"].as_u64()).unwrap_or(0) + 1;
        let mut policy = serde_json::json!({
            "tier": tier,
            "policyId": policy_id,
            "revision": revision,
            "updatedAt": at,
        });
        if let Some(ref d) = delegated_at {
            policy["delegatedAt"] = Value::String(d.clone());
        }
        let binding_conv = current
            .agent_conversation_id
            .as_deref()
            .map(|c| serde_json::json!(c))
            .unwrap_or(Value::Null);
        current.unknown_outcome_policy = Some(policy);
        self.save(current)?;

        let mut out = serde_json::json!({
            "workspaceId": workspace_id,
            "agentConversationId": binding_conv,
            "tier": tier,
            "policyId": policy_id,
            "revision": revision,
            "updatedAt": at,
        });
        if let Some(d) = delegated_at {
            out["delegatedAt"] = Value::String(d);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn avatar_hash_and_profile_roundtrip_match_protocol() {
        // Matches JS fnv1a("ws-1") deterministically.
        let a1 = generate_avatar("ws-1");
        let a2 = generate_avatar("ws-1");
        assert_eq!(a1, a2);
        assert_eq!(clean_display_name("  /foo\\bar\x07... "), "foobar");

        let dir = tempdir().unwrap();
        let store = BotProfileStore::new(dir.path());
        let (created, is_new) = store
            .create(&CreateBotProfile {
                workspace_id: "ws-1",
                display_name: "Peer Bot",
                managed: false,
                agent_conversation_id: "conv-1",
                avatar_salt: "",
            })
            .unwrap();
        assert!(is_new);
        assert_eq!(created.display_name, "Peer Bot");
        assert!(created.is_active());

        // Idempotent second create returns existing profile.
        let (again, is_new2) = store
            .create(&CreateBotProfile {
                workspace_id: "ws-1",
                display_name: "Different",
                managed: false,
                agent_conversation_id: "conv-2",
                avatar_salt: "",
            })
            .unwrap();
        assert!(!is_new2);
        assert_eq!(again.display_name, "Peer Bot");
    }

    #[test]
    fn unknown_outcome_policy_delegates_revokes_and_rejects_unsupported() {
        let dir = tempdir().unwrap();
        let store = BotProfileStore::new(dir.path());
        store
            .create(&CreateBotProfile {
                workspace_id: "ws-1",
                display_name: "Policy Bot",
                managed: false,
                agent_conversation_id: "conv-1",
                avatar_salt: "",
            })
            .unwrap();

        let initial = store.read_unknown_outcome_policy("ws-1").unwrap();
        assert_eq!(initial["tier"], "ask");
        assert_eq!(initial["agentConversationId"], "conv-1");

        let delegated = store
            .set_unknown_outcome_policy("ws-1", "bot_verified")
            .unwrap();
        assert_eq!(delegated["tier"], "bot_verified");
        assert_eq!(delegated["revision"], 1);
        let first_delegated_at = delegated["delegatedAt"].as_str().unwrap().to_owned();
        let policy_id = delegated["policyId"].as_str().unwrap().to_owned();

        let revoked = store.set_unknown_outcome_policy("ws-1", "ask").unwrap();
        assert_eq!(revoked["tier"], "ask");
        assert_eq!(revoked["revision"], 2);
        assert_eq!(revoked["policyId"], policy_id);
        assert_eq!(revoked["delegatedAt"], first_delegated_at);

        let again = store
            .set_unknown_outcome_policy("ws-1", "bot_verified")
            .unwrap();
        assert_eq!(again["revision"], 3);
        assert_eq!(again["policyId"], policy_id);

        assert_eq!(
            store
                .set_unknown_outcome_policy("ws-1", "auto")
                .unwrap_err()
                .code,
            "INVALID_UNKNOWN_OUTCOME_TIER"
        );
        assert_eq!(
            store
                .read_unknown_outcome_policy("missing")
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );

        let mut profile = store.read("ws-1").unwrap();
        profile.unknown_outcome_policy = Some(serde_json::json!({
            "tier": "auto",
            "policyId": "bad",
            "revision": 1,
            "updatedAt": "2026-11-09T00:00:00.000Z",
        }));
        store.save(profile).unwrap();
        assert_eq!(
            store.read_unknown_outcome_policy("ws-1").unwrap_err().code,
            "UNKNOWN_OUTCOME_POLICY_UNSUPPORTED"
        );
        assert_eq!(
            store
                .set_unknown_outcome_policy("ws-1", "ask")
                .unwrap_err()
                .code,
            "UNKNOWN_OUTCOME_POLICY_UNSUPPORTED"
        );
    }
}
