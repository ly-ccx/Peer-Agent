use crate::permission_digest::{DigestError, interactive_json};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value, value::RawValue};
use sha2::{Digest, Sha256};

pub const INTERACTIVE_RESULT_PREFIX: &str = "interactive-result://";
pub const INTERACTIVE_PUBLISH_CAPABILITY: &str = "local.interactive.publish";
pub const INTERACTIVE_PUBLISH_TOOL: &str = "publish_interactive_result";
pub const INTERACTIVE_FALLBACK_BYTES: usize = 32 * 1024;
pub const INTERACTIVE_SUMMARY_UNITS: usize = 8192;
pub const INTERACTIVE_MANIFEST_BYTES: usize = 2 * 1024 * 1024;

pub fn interactive_token(value: &str) -> bool {
    value.len() <= 256
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
        && !value.contains("..")
}

fn hex_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn interactive_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(hex_hash)
}

pub fn interactive_canonical_json(value: &Value) -> Result<String, DigestError> {
    interactive_json(value)
}

pub fn interactive_json_digest(value: &Value) -> Result<String, DigestError> {
    let canonical = interactive_json(value)?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical.as_bytes())))
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractiveOwner {
    pub workspace_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractiveResultReference {
    pub owner: InteractiveOwner,
    pub result_id: String,
    pub content_version: String,
}

impl InteractiveResultReference {
    pub fn parse(input: &str) -> Option<Self> {
        if input.encode_utf16().take(1025).count() > 1024 {
            return None;
        }
        let mut parts = input.strip_prefix(INTERACTIVE_RESULT_PREFIX)?.split('/');
        let (workspace_id, conversation_id, result_id, hash) =
            (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() || !hex_hash(hash) {
            return None;
        }
        let reference = Self {
            owner: InteractiveOwner {
                workspace_id: workspace_id.into(),
                conversation_id: conversation_id.into(),
            },
            result_id: result_id.into(),
            content_version: format!("sha256:{hash}"),
        };
        reference.is_valid().then_some(reference)
    }

    pub fn is_valid(&self) -> bool {
        interactive_token(&self.owner.workspace_id)
            && interactive_token(&self.owner.conversation_id)
            && interactive_token(&self.result_id)
            && interactive_digest(&self.content_version)
    }

    pub fn locator(&self) -> String {
        let hash = self.content_version.strip_prefix("sha256:").unwrap_or("");
        format!(
            "{INTERACTIVE_RESULT_PREFIX}{}/{}/{}/{hash}",
            self.owner.workspace_id, self.owner.conversation_id, self.result_id
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractiveAvailability {
    Available,
    Cleaned,
    OriginOnly,
}

impl InteractiveAvailability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Cleaned => "cleaned",
            Self::OriginOnly => "origin_only",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractiveResultSource {
    pub conversation_id: String,
    pub plan_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_epoch: Option<String>,
}

impl InteractiveResultSource {
    pub fn is_valid(&self) -> bool {
        [
            &self.conversation_id,
            &self.plan_id,
            &self.session_id,
            &self.tool_call_id,
        ]
        .iter()
        .all(|id| interactive_token(id))
            && self
                .execution_epoch
                .as_ref()
                .is_none_or(|epoch| !epoch.is_empty() && epoch.encode_utf16().count() <= 512)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveResultSummary {
    pub schema_version: u8,
    pub availability: InteractiveAvailability,
    pub summary_kind: &'static str,
    #[serde(rename = "ref")]
    pub locator: String,
    pub reference: InteractiveResultReference,
    pub source: InteractiveResultSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_schema_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library_version: Option<String>,
    pub title: String,
    pub text_fallback: InteractiveSummaryText,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleaned_at: Option<String>,
}

/// JS stores and presents lengths in UTF-16. The old writer can cut directly
/// after an emoji's high surrogate, which JSON keeps escaped and stdout's
/// UTF-8 encoder displays as the replacement character.
#[derive(Debug)]
pub struct InteractiveSummaryText {
    pub text: String,
    trailing_high_surrogate: Option<u16>,
}

impl InteractiveSummaryText {
    pub fn new(text: String) -> Self {
        Self {
            text,
            trailing_high_surrogate: None,
        }
    }

    pub fn with_partial_character(mut self, unit: u16) -> Option<Self> {
        if !(0xd800..=0xdbff).contains(&unit) {
            return None;
        }
        self.trailing_high_surrogate = Some(unit);
        Some(self)
    }

    pub fn suffix(&self) -> &'static str {
        if self.trailing_high_surrogate.is_some() {
            "\u{fffd}"
        } else {
            ""
        }
    }
}

impl Serialize for InteractiveSummaryText {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::Error;
        use std::fmt::Write as _;
        let Some(unit) = self.trailing_high_surrogate else {
            return serializer.serialize_str(&self.text);
        };
        let mut quoted = serde_json::to_string(&self.text).map_err(S::Error::custom)?;
        quoted.pop();
        write!(quoted, "\\u{unit:04x}\"").map_err(S::Error::custom)?;
        let raw = RawValue::from_string(quoted).map_err(S::Error::custom)?;
        raw.serialize(serializer)
    }
}
