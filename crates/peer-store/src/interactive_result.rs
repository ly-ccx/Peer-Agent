//! Static local reports from the existing Interactive Result stores.
use crate::{files, valid_id};
use peer_protocol::{
    JsonLimits, decode_json_bounded,
    interactive_result::{
        INTERACTIVE_FALLBACK_BYTES, InteractiveAvailability, InteractiveResultReference,
        InteractiveResultSource, InteractiveResultSummary, InteractiveSummaryText,
    },
    javascript_trim,
};
use serde_json::Value;
use std::path::Path;

mod local;
mod portable;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InteractiveReadError(&'static str);

impl InteractiveReadError {
    pub fn code(self) -> &'static str {
        self.0
    }
    pub fn scope_denied(self) -> bool {
        self == DENIED
    }
}

type Read<T> = Result<T, InteractiveReadError>;
const DENIED: InteractiveReadError = InteractiveReadError("interactive_scope_denied");
const UNAVAILABLE: InteractiveReadError = InteractiveReadError("interactive_result_unavailable");
const FALLBACK_BYTES: usize = INTERACTIVE_FALLBACK_BYTES;

pub fn read_interactive_result(
    home: &Path,
    reference: &InteractiveResultReference,
) -> Read<InteractiveResultSummary> {
    if !reference.is_valid() {
        return Err(InteractiveReadError("interactive_reference_invalid"));
    }
    let profile = profile_identity(home, reference).ok_or(DENIED)?;
    let result = match local::read_local(home, reference)? {
        Some(summary) => summary,
        None => {
            let portable = portable::read_portable(home, reference).ok_or(UNAVAILABLE)?;
            // A newly registered local version, pending operation or tombstone
            // still takes precedence over an already-read portable summary.
            local::read_local(home, reference)?.unwrap_or(portable)
        }
    };
    if profile_identity(home, reference).as_ref() != Some(&profile) {
        return Err(DENIED);
    }
    Ok(result)
}

fn profile_identity(
    home: &Path,
    reference: &InteractiveResultReference,
) -> Option<files::FileIdentity> {
    let owner = &reference.owner;
    if !valid_id(&owner.workspace_id, true) {
        return None;
    }
    let dir = home.join("projects");
    let project = dir.join(&owner.workspace_id);
    if ![&dir, &project]
        .iter()
        .all(|path| std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()))
    {
        return None;
    }
    let path = project.join("profile.json");
    let before = files::identity(&path).ok()??;
    let body = files::read(&path, 1_048_576).ok()??;
    let profile = decode(&body, 1_048_576)?;
    if profile["workspaceId"] != owner.workspace_id
        || profile["agentConversationId"] != owner.conversation_id
        || profile["status"] != "active"
        || profile["displayName"].as_str().is_none_or(str::is_empty)
        || !(profile["avatar"].is_object() || profile["avatar"].is_array())
        || files::identity(&path).ok()?.as_ref() != Some(&before)
    {
        return None;
    }
    Some(before)
}

fn decode(bytes: &[u8], limit: usize) -> Option<Value> {
    Some(
        decode_json_bounded(
            bytes,
            JsonLimits {
                bytes: limit,
                nodes: 65_536,
                depth: 64,
                string_bytes: limit,
            },
        )
        .ok()?
        .value,
    )
}

fn artifact<'a>(
    record: &'a Value,
    reference: &InteractiveResultReference,
    locator: &str,
) -> Option<&'a Value> {
    record["userArtifacts"].as_array()?.iter().find(|item| {
        item.as_object().is_some_and(|v| v.len() == 5)
            && item["kind"] == "interactive"
            && item["ref"] == locator
            && item["specHash"]
                .as_str()
                .is_some_and(peer_protocol::interactive_result::interactive_digest)
            && item["label"].as_str().is_some_and(|label| {
                label.len() <= 640
                    && label.encode_utf16().count() <= 160
                    && !javascript_trim(label).is_empty()
                    && !label.contains('\0')
            })
            && ref_equals(&item["reference"], reference)
    })
}

fn ref_equals(value: &Value, reference: &InteractiveResultReference) -> bool {
    serde_json::from_value::<InteractiveResultReference>(value.clone())
        .is_ok_and(|parsed| parsed == *reference)
}

fn source(value: &Value) -> Option<InteractiveResultSource> {
    let source: InteractiveResultSource = serde_json::from_value(value.clone()).ok()?;
    (source.is_valid() && source.execution_epoch.is_some()).then_some(source)
}

fn summary(
    reference: &InteractiveResultReference,
    availability: InteractiveAvailability,
    source: InteractiveResultSource,
    title: String,
    text_fallback: String,
    truncated: bool,
) -> InteractiveResultSummary {
    InteractiveResultSummary {
        schema_version: 1,
        availability,
        summary_kind: "saved-model-summary",
        locator: reference.locator(),
        reference: reference.clone(),
        source,
        data_level: None,
        content_schema_version: None,
        library_version: None,
        title,
        text_fallback: InteractiveSummaryText::new(text_fallback),
        truncated,
        cleaned_at: None,
    }
}

fn included(value: &Value, expected: &str) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().any(|value| value == expected))
}
