//! Reconcile completed cleanup operations from the same read-only local
//! SQLite snapshot used by fixed Interactive Results.
use super::*;
use peer_protocol::interactive_result::{
    INTERACTIVE_MANIFEST_BYTES, interactive_canonical_json, interactive_digest,
    interactive_json_digest, interactive_token,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::json;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const INPUT_LIMIT: usize = 8192;
const INVALID: InteractiveReadError = InteractiveReadError("interactive_cleanup_invalid");
const CONFLICT: InteractiveReadError =
    InteractiveReadError("interactive_cleanup_parameter_conflict");
const BAD_FOLLOWUP: InteractiveReadError = InteractiveReadError("interactive_followup_corrupt");
const NO_FOLLOWUP: InteractiveReadError = InteractiveReadError("interactive_followup_unavailable");
const BAD_MATERIAL: InteractiveReadError = InteractiveReadError("interactive_storage_corrupt");
const NO_MATERIAL: InteractiveReadError = InteractiveReadError("material_snapshot_unavailable");

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Result,
    Followup,
    Material,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    op: String,
    kind: Kind,
    target: Value,
    request_id: String,
    expected_digest: String,
}

pub struct InteractiveCleanupRequest {
    input: Input,
    owner: InteractiveOwner,
}

impl InteractiveCleanupRequest {
    pub const MAX_BYTES: usize = INPUT_LIMIT;

    pub fn parse(bytes: &[u8]) -> Read<Self> {
        let input: Input = serde_json::from_value(decode(bytes, INPUT_LIMIT).ok_or(INVALID)?)
            .map_err(|_| INVALID)?;
        if input.op != "receipt"
            || !interactive_token(&input.request_id)
            || !interactive_digest(&input.expected_digest)
        {
            return Err(INVALID);
        }
        let owner = match input.kind {
            Kind::Result => reference(&input.target).map(|reference| reference.owner),
            _ => serde_json::from_value::<InteractiveOwner>(input.target["owner"].clone()).ok(),
        }
        .filter(|owner| {
            interactive_token(&owner.workspace_id) && interactive_token(&owner.conversation_id)
        })
        .ok_or(INVALID)?;
        Ok(Self { input, owner })
    }
}

pub fn read_interactive_cleanup_receipt(
    home: &Path,
    request: &InteractiveCleanupRequest,
) -> Read<Option<String>> {
    let profile = profile_identity(home, &request.owner).ok_or(DENIED)?;
    let input = &request.input;
    let owner = &request.owner;
    let owner_key = interactive_canonical_json(&json!(owner)).map_err(|_| INVALID)?;
    let output = match input.kind {
        Kind::Result => {
            let target = reference(&input.target).ok_or(INVALID)?;
            let saved =
                local::read_snapshot(home, owner, |db| local::tombstone::read_saved(db, &target))?;
            if let Some(saved) = saved {
                if saved.head != target {
                    return Err(CONFLICT);
                }
                matches_request(input, &saved.request_id, &saved.expected_digest)?;
                Some(saved.into_json()?)
            } else {
                None
            }
        }
        Kind::Followup => {
            let id = input.target["followupId"]
                .as_str()
                .filter(|id| interactive_token(id))
                .ok_or(InteractiveReadError("interactive_followup_invalid"))?;
            local::read_snapshot(home, owner, |db| {
                read_followup(db, &owner_key, owner, id, input).map(Some)
            })?
            .ok_or(NO_FOLLOWUP)?
        }
        Kind::Material => {
            let source = &input.target["source"];
            let (key, version) = material_key(source).ok_or(NO_MATERIAL)?;
            local::read_snapshot(home, owner, |db| {
                read_material(db, &owner_key, source, &key, version, input).map(Some)
            })?
            .ok_or(NO_MATERIAL)?
        }
    };
    if profile_identity(home, owner).as_ref() != Some(&profile) {
        return Err(DENIED);
    }
    Ok(output)
}

fn reference(raw: &Value) -> Option<InteractiveResultReference> {
    serde_json::from_value::<InteractiveResultReference>(raw.clone())
        .ok()
        .filter(InteractiveResultReference::is_valid)
}

fn matches_request(input: &Input, request_id: &str, digest: &str) -> Read<()> {
    if request_id != input.request_id || digest != input.expected_digest {
        return Err(CONFLICT);
    }
    Ok(())
}

fn linked_digest(value: &Value, field: &str) -> bool {
    let mut body = value.clone();
    let Some(digest) = body.as_object_mut().and_then(|fields| fields.remove(field)) else {
        return false;
    };
    digest.as_str().is_some_and(|digest| {
        interactive_digest(digest)
            && interactive_json_digest(&body).is_ok_and(|actual| actual == digest)
    })
}

fn timestamp(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| OffsetDateTime::parse(text, &Rfc3339).is_ok())
}

fn retired(value: &Value, input: &Input, invalid: InteractiveReadError) -> Read<Option<String>> {
    let request_id = value["requestId"]
        .as_str()
        .filter(|id| interactive_token(id))
        .ok_or(invalid)?;
    let expected_digest = value["expectedDigest"]
        .as_str()
        .filter(|digest| interactive_digest(digest))
        .ok_or(invalid)?;
    if !value.as_object().is_some_and(|fields| fields.len() == 9)
        || value["schemaVersion"] != 1
        || !timestamp(&value["cleanedAt"])
        || !linked_digest(value, "receiptDigest")
    {
        return Err(invalid);
    }
    matches_request(input, request_id, expected_digest)?;
    interactive_canonical_json(value)
        .map(Some)
        .map_err(|_| invalid)
}

fn read_followup(
    db: &Connection,
    owner_key: &str,
    owner: &InteractiveOwner,
    id: &str,
    input: &Input,
) -> Read<Option<String>> {
    let row: Option<(String, String, String)> = db
        .query_row(
            "SELECT owner,argsDigest,snapshot FROM followups WHERE id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| BAD_FOLLOWUP)?;
    let Some((row_owner, args_digest, snapshot)) = row.filter(|row| row.0 == owner_key) else {
        return Err(NO_FOLLOWUP);
    };
    let snapshot = decode(snapshot.as_bytes(), INTERACTIVE_MANIFEST_BYTES).ok_or(BAD_FOLLOWUP)?;
    if !interactive_digest(&args_digest)
        || snapshot["followupId"] != id
        || interactive_canonical_json(&snapshot["recipient"]).as_deref() != Ok(row_owner.as_str())
    {
        return Err(BAD_FOLLOWUP);
    }
    if snapshot["kind"] == "interactive-followup-retired" {
        if snapshot["argsDigest"] != args_digest {
            return Err(BAD_FOLLOWUP);
        }
        return retired(&snapshot, input, BAD_FOLLOWUP);
    }
    if !active_followup(&snapshot, owner) {
        return Err(BAD_FOLLOWUP);
    }
    Ok(None)
}

fn active_followup(value: &Value, owner: &InteractiveOwner) -> bool {
    value.as_object().is_some_and(|fields| fields.len() == 11)
        && reference(&value["result"]).is_some_and(|reference| reference.owner == *owner)
        && ["specHash", "stateDigest"]
            .iter()
            .all(|field| value[*field].as_str().is_some_and(interactive_digest))
        && value["stateRevision"]
            .as_u64()
            .is_some_and(|revision| revision <= 9_007_199_254_740_991)
        && value["values"].as_object().is_some_and(|values| {
            !values.is_empty()
                && values.len() <= 64
                && values.iter().all(|(key, value)| {
                    key.strip_prefix('$').is_some_and(|name| {
                        name.len() <= 64
                            && name
                                .bytes()
                                .next()
                                .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
                            && name
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    }) && (value.is_boolean()
                        || value.is_number()
                        || value.as_str().is_some_and(|text| {
                            text.encode_utf16().count() <= 8192 && !text.contains('\0')
                        }))
                })
        })
        && matches!(
            value["dataLevel"].as_str(),
            Some("D0_public" | "D1_internal" | "D2_sensitive" | "D3_private" | "D4_regulated")
        )
        && value["capturedAt"]
            .as_str()
            .is_some_and(|text| text.len() <= 40)
        && timestamp(&value["capturedAt"])
        && value["excerpt"].as_str().is_some_and(|text| {
            text.len() <= 8192 && !text.contains('\0') && !javascript_trim(text).is_empty()
        })
        && linked_digest(value, "selectionDigest")
        && serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= 32 * 1024)
}

fn material_key(source: &Value) -> Option<(String, &str)> {
    let identifier = |field: &str| source[field].as_str().filter(|id| interactive_token(id));
    let version = source["expectedContentVersion"]
        .as_str()
        .filter(|digest| interactive_digest(digest))?;
    let fields = match source["kind"].as_str()? {
        "tool-result" => json!([
            "tool-result",
            identifier("conversationId")?,
            identifier("toolCallId")?
        ]),
        "user-material" => json!([
            "user-material",
            identifier("messageId")?,
            identifier("attachmentId")?,
            version
        ]),
        _ => return None,
    };
    Some((interactive_json_digest(&fields).ok()?, version))
}

fn read_material(
    db: &Connection,
    owner_key: &str,
    source: &Value,
    key: &str,
    version: &str,
    input: &Input,
) -> Read<Option<String>> {
    let row: Option<(String, String, String)> = db
        .query_row(
            "SELECT owner,object,metadata FROM materials WHERE id=?",
            [key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| BAD_MATERIAL)?;
    let Some((row_owner, object, metadata)) = row.filter(|row| row.0 == owner_key) else {
        return Err(NO_MATERIAL);
    };
    let metadata = decode(metadata.as_bytes(), INTERACTIVE_MANIFEST_BYTES).ok_or(BAD_MATERIAL)?;
    if interactive_canonical_json(&metadata["owner"]).as_deref() != Ok(row_owner.as_str()) {
        return Err(BAD_MATERIAL);
    }
    if interactive_canonical_json(&metadata["source"]).ok()
        != Some(interactive_canonical_json(source).map_err(|_| BAD_MATERIAL)?)
    {
        return Err(InteractiveReadError("material_version_mismatch"));
    }
    if metadata["contentVersion"] != version {
        return Err(BAD_MATERIAL);
    }
    if object.is_empty() {
        if metadata["kind"] != "interactive-material-retired" {
            return Err(BAD_MATERIAL);
        }
        return retired(&metadata, input, BAD_MATERIAL);
    }
    if object != version
        || metadata["kind"] == "interactive-material-retired"
        || metadata.get("origin").is_some_and(|origin| {
            source["kind"] != "user-material"
                || !origin.as_object().is_some_and(|fields| fields.len() == 3)
                || ["conversationId", "planId", "sessionId"]
                    .iter()
                    .any(|field| !origin[*field].as_str().is_some_and(interactive_token))
        })
    {
        return Err(BAD_MATERIAL);
    }
    Ok(None)
}
