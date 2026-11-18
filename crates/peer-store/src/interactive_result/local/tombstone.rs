use super::*;
use peer_protocol::interactive_result::interactive_token;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const CLEANUP_CORRUPT: InteractiveReadError = InteractiveReadError("interactive_cleanup_corrupt");

pub(super) fn read(
    db: &Connection,
    reference: &InteractiveResultReference,
) -> Read<InteractiveResultSummary> {
    let owner = owner_json(reference)?;
    let raw: String = db.query_row(
        "SELECT body FROM presentation WHERE category='interactive-cleanup' AND id=? AND owner=?",
        params![reference.result_id, owner],
        |r| r.get(0),
    ).optional().map_err(|_| CLEANUP_CORRUPT)?.ok_or(CLEANUP_CORRUPT)?;
    let (receipt, partial) = decode_receipt(&raw).ok_or(CLEANUP_CORRUPT)?;
    if receipt.as_object().is_none_or(|fields| fields.len() != 9)
        || receipt["schemaVersion"] != 1
        || !receipt["requestId"].as_str().is_some_and(interactive_token)
        || !receipt["expectedDigest"]
            .as_str()
            .is_some_and(interactive_digest)
        || ["stateRowsRemoved", "saveRowsRemoved", "objectBytesRemoved"]
            .iter()
            .any(|key| {
                !receipt[*key]
                    .as_u64()
                    .is_some_and(|n| n <= 9_007_199_254_740_991)
            })
    {
        return Err(CLEANUP_CORRUPT);
    }
    let cleaned_at = receipt["cleanedAt"]
        .as_str()
        .filter(|s| OffsetDateTime::parse(s, &Rfc3339).is_ok())
        .ok_or(CLEANUP_CORRUPT)?;
    let head = target_reference(&receipt["reference"], reference)?;
    let versions = receipt["versions"]
        .as_array()
        .filter(|rows| !rows.is_empty())
        .ok_or(CLEANUP_CORRUPT)?;
    let mut seen = HashSet::new();
    let mut summary_row = None;
    for (index, version_row) in versions.iter().enumerate() {
        let target = target_reference(&version_row["reference"], reference)?;
        let title = version_row["title"]
            .as_str()
            .filter(|s| s.encode_utf16().count() <= 160)
            .ok_or(CLEANUP_CORRUPT)?;
        let unit = partial.get(&index).copied();
        let fallback = version_row["textFallback"]
            .as_str()
            .filter(|s| {
                let length = s.encode_utf16().count();
                if unit.is_some() {
                    length == 255
                } else {
                    length <= 256
                }
            })
            .ok_or(CLEANUP_CORRUPT)?;
        let truncated = version_row["truncated"].as_bool().ok_or(CLEANUP_CORRUPT)?;
        let level = data_level(&version_row["dataLevel"]).ok_or(CLEANUP_CORRUPT)?;
        if !version_row
            .as_object()
            .is_some_and(|fields| fields.len() == 6)
            || !seen.insert(target.content_version.clone())
        {
            return Err(CLEANUP_CORRUPT);
        }
        let row = version(db, &target)?.ok_or(CLEANUP_CORRUPT)?;
        let origin = source(&row.metadata["source"]).ok_or(CLEANUP_CORRUPT)?;
        if row.availability != "cleaned"
            || version_row["source"] != row.metadata["source"]
            || version_row["dataLevel"] != row.metadata["dataLevel"]
        {
            return Err(CLEANUP_CORRUPT);
        }
        operation(db, &target, &row.metadata, &origin, true)?;
        if target == *reference {
            let mut result = summary(
                reference,
                InteractiveAvailability::Cleaned,
                origin,
                title.into(),
                fallback.into(),
                truncated,
            );
            result.data_level = Some(level);
            result.cleaned_at = Some(cleaned_at.into());
            if let Some(unit) = unit {
                result.text_fallback = result
                    .text_fallback
                    .with_partial_character(unit)
                    .ok_or(CLEANUP_CORRUPT)?;
            }
            summary_row = Some(result);
        }
    }
    let count: usize = db
        .query_row(
            "SELECT COUNT(*) FROM versions WHERE id=? AND owner=?",
            params![reference.result_id, owner],
            |r| r.get(0),
        )
        .map_err(|_| CLEANUP_CORRUPT)?;
    let result: (String, String) = db
        .query_row(
            "SELECT owner,head FROM results WHERE id=?",
            [&reference.result_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| CLEANUP_CORRUPT)?;
    if count != seen.len()
        || !seen.contains(&head.content_version)
        || result != (owner, head.content_version)
    {
        return Err(CLEANUP_CORRUPT);
    }
    summary_row.ok_or(CLEANUP_CORRUPT)
}

type PartialCharacters = BTreeMap<usize, u16>;
type RawFields = BTreeMap<String, Box<RawValue>>;

fn decode_receipt(raw: &str) -> Option<(Value, PartialCharacters)> {
    if raw.len() > LIMIT {
        return None;
    }
    if let Some(mut receipt) = decode(raw.as_bytes(), LIMIT) {
        let digest = receipt.as_object_mut()?.remove("receiptDigest")?;
        let expected = digest.as_str().filter(|hash| interactive_digest(hash))?;
        return (interactive_json_digest(&receipt).ok()? == expected)
            .then_some((receipt, BTreeMap::new()));
    }

    // The legacy cleanup writer produced canonical bytes before storing them.
    // Validate those exact bytes before converting its one permitted split
    // character for Rust. Every other malformed string remains invalid.
    let mut fields: RawFields = serde_json::from_str(raw).ok()?;
    if serde_json::to_string(&fields).ok()? != raw {
        return None;
    }
    let saved_digest = fields.remove("receiptDigest")?;
    let digest: String = serde_json::from_str(saved_digest.get()).ok()?;
    let bytes = serde_json::to_vec(&fields).ok()?;
    if format!("sha256:{:x}", Sha256::digest(bytes)) != digest {
        return None;
    }
    let mut versions: Vec<RawFields> = serde_json::from_str(fields.get("versions")?.get()).ok()?;
    let mut partial = BTreeMap::new();
    for (index, row) in versions.iter_mut().enumerate() {
        let text = row.get_mut("textFallback")?;
        if serde_json::from_str::<String>(text.get()).is_ok() {
            continue;
        }
        let (prefix, unit) = split_trailing_high_surrogate(text.get())?;
        *text = RawValue::from_string(serde_json::to_string(&prefix).ok()?).ok()?;
        partial.insert(index, unit);
    }
    if partial.is_empty() {
        return None;
    }
    let normalized = RawValue::from_string(serde_json::to_string(&versions).ok()?).ok()?;
    fields.insert("versions".into(), normalized);
    let decoded = decode(&serde_json::to_vec(&fields).ok()?, LIMIT)?;
    interactive_canonical_json(&decoded).ok()?;
    Some((decoded, partial))
}

fn split_trailing_high_surrogate(quoted: &str) -> Option<(String, u16)> {
    let interior = quoted.strip_suffix('"')?;
    let (prefix, suffix) = interior.rsplit_once("\\u")?;
    if suffix.len() != 4 {
        return None;
    }
    let unit = u16::from_str_radix(suffix, 16).ok()?;
    if !(0xd800..=0xdbff).contains(&unit) {
        return None;
    }
    let prefix = serde_json::from_str::<String>(&format!("{prefix}\"")).ok()?;
    if prefix.encode_utf16().count() != 255 {
        return None;
    }
    Some((prefix, unit))
}

fn target_reference(
    value: &Value,
    reference: &InteractiveResultReference,
) -> Read<InteractiveResultReference> {
    let target: InteractiveResultReference =
        serde_json::from_value(value.clone()).map_err(|_| CLEANUP_CORRUPT)?;
    if !target.is_valid()
        || target.owner != reference.owner
        || target.result_id != reference.result_id
    {
        return Err(CLEANUP_CORRUPT);
    }
    Ok(target)
}
