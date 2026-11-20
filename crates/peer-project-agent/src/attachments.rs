//! Multimodal user upload admission, local image loading, and canonical history
//! attachment projection (`packages/runtime-node/src/project-agent/input-attachments.mjs`
//! and `crates/peer-runtime/src/canonical_history.rs`).

use crate::{ProjectError, is_valid_input_id};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

pub const INPUT_ATTACHMENT_LIMIT: usize = 8;
pub const MAX_IMAGE_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TEXT_ATTACHMENT_BYTES: usize = 512 * 1024;

const B64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(B64_TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64_TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn b64_val(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn base64_decode_strict(s: &str) -> Result<Vec<u8>, ProjectError> {
    let bytes = s.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return Err(ProjectError::new(
            "INVALID_ATTACHMENT",
            "attachment image data is invalid",
        ));
    }
    let pad = if bytes.ends_with(b"==") {
        2
    } else if bytes.ends_with(b"=") {
        1
    } else {
        0
    };
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3 - pad);
    let num_chunks = bytes.len() / 4;
    for (ci, chunk) in bytes.as_chunks::<4>().0.iter().enumerate() {
        let last = ci + 1 == num_chunks;
        let a = b64_val(chunk[0]);
        let b = b64_val(chunk[1]);
        let c = if last && pad >= 2 {
            (chunk[2] == b'=').then_some(0)
        } else {
            b64_val(chunk[2])
        };
        let d = if last && pad >= 1 {
            (chunk[3] == b'=').then_some(0)
        } else {
            b64_val(chunk[3])
        };
        let (Some(a), Some(b), Some(c), Some(d)) = (a, b, c, d) else {
            return Err(ProjectError::new(
                "INVALID_ATTACHMENT",
                "attachment image data is invalid",
            ));
        };
        let triple =
            (u32::from(a) << 18) | (u32::from(b) << 12) | (u32::from(c) << 6) | u32::from(d);
        out.push(((triple >> 16) & 0xff) as u8);
        if !(last && pad >= 2) {
            out.push(((triple >> 8) & 0xff) as u8);
        }
        if !(last && pad >= 1) {
            out.push((triple & 0xff) as u8);
        }
    }
    Ok(out)
}

fn clip_token(raw: Option<&str>, limit: usize, fallback: &str) -> String {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return fallback.to_owned();
    };
    s.chars().take(limit).collect()
}

fn is_valid_image_mime_subtype(mime: &str) -> bool {
    let Some(sub) = mime.strip_prefix("image/") else {
        return false;
    };
    !sub.is_empty()
        && sub
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
}

/// Normalize and validate one user attachment matching `input-attachments.mjs#normalizeUserUpload`.
pub fn normalize_user_upload(item: &Value) -> Result<Value, ProjectError> {
    let Some(obj) = item.as_object() else {
        return Err(ProjectError::new(
            "INVALID_ATTACHMENT",
            "attachment must be an object",
        ));
    };
    let size = obj
        .get("size")
        .and_then(Value::as_u64)
        .filter(|s| *s <= (u64::MAX / 2))
        .ok_or_else(|| ProjectError::new("INVALID_ATTACHMENT", "attachment size is invalid"))?
        as usize;

    let id = clip_token(obj.get("id").and_then(Value::as_str), 80, "attachment");
    let name = clip_token(obj.get("name").and_then(Value::as_str), 240, "file");
    let mime_type = clip_token(
        obj.get("mimeType").and_then(Value::as_str),
        100,
        "application/octet-stream",
    );

    match obj.get("kind").and_then(Value::as_str) {
        Some("image") => {
            let url = obj.get("dataUrl").and_then(Value::as_str).ok_or_else(|| {
                ProjectError::new("INVALID_ATTACHMENT", "attachment image data is invalid")
            })?;
            let rest = url.strip_prefix("data:").ok_or_else(|| {
                ProjectError::new("INVALID_ATTACHMENT", "attachment image data is invalid")
            })?;
            let (header, b64) = rest.split_once(',').ok_or_else(|| {
                ProjectError::new("INVALID_ATTACHMENT", "attachment image data is invalid")
            })?;
            let url_mime = header.strip_suffix(";base64").ok_or_else(|| {
                ProjectError::new("INVALID_ATTACHMENT", "attachment image data is invalid")
            })?;
            if !is_valid_image_mime_subtype(url_mime) || url_mime != mime_type {
                return Err(ProjectError::new(
                    "INVALID_ATTACHMENT",
                    "attachment image data is invalid",
                ));
            }
            if size > MAX_IMAGE_ATTACHMENT_BYTES
                || b64.len() > MAX_IMAGE_ATTACHMENT_BYTES.div_ceil(3) * 4
            {
                return Err(ProjectError::new(
                    "INVALID_ATTACHMENT",
                    "attachment image exceeds 8 MiB",
                ));
            }
            let decoded = base64_decode_strict(b64)?;
            if decoded.len() > MAX_IMAGE_ATTACHMENT_BYTES {
                return Err(ProjectError::new(
                    "INVALID_ATTACHMENT",
                    "attachment image exceeds 8 MiB",
                ));
            }
            Ok(json!({
                "id": id,
                "name": name,
                "mimeType": mime_type,
                "size": size,
                "sourceKind": "user_upload",
                "kind": "image",
                "dataUrl": url,
            }))
        }
        Some("text") => {
            let text = obj.get("text").and_then(Value::as_str).ok_or_else(|| {
                ProjectError::new("INVALID_ATTACHMENT", "attachment text is invalid")
            })?;
            if size > MAX_TEXT_ATTACHMENT_BYTES || text.len() > MAX_TEXT_ATTACHMENT_BYTES {
                return Err(ProjectError::new(
                    "INVALID_ATTACHMENT",
                    "attachment text exceeds 512 KiB",
                ));
            }
            Ok(json!({
                "id": id,
                "name": name,
                "mimeType": mime_type,
                "size": size,
                "sourceKind": "user_upload",
                "kind": "text",
                "text": text,
            }))
        }
        Some("unsupported") => Ok(json!({
            "id": id,
            "name": name,
            "mimeType": mime_type,
            "size": size,
            "sourceKind": "user_upload",
            "kind": "unsupported",
        })),
        _ => Err(ProjectError::new(
            "INVALID_ATTACHMENT",
            "attachment kind is invalid",
        )),
    }
}

pub fn normalize_input_attachments(items: &[Value]) -> Result<Vec<Value>, ProjectError> {
    if items.len() > INPUT_ATTACHMENT_LIMIT {
        return Err(ProjectError::new(
            "ATTACHMENT_LIMIT",
            "attachments exceed limit of 8",
        ));
    }
    items.iter().map(normalize_user_upload).collect()
}

fn image_media_type(path: &Path) -> Option<(&'static str, &'static str)> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "png" => ("png", "image/png"),
            "jpg" | "jpeg" => ("jpg", "image/jpeg"),
            "gif" => ("gif", "image/gif"),
            "webp" => ("webp", "image/webp"),
            "bmp" => ("bmp", "image/bmp"),
            "tif" | "tiff" => ("tiff", "image/tiff"),
            _ => return None,
        },
    )
}

fn matches_image_magic(mime: &str, data: &[u8]) -> bool {
    match mime {
        "image/png" => {
            data.len() >= 24 && data.starts_with(b"\x89PNG\r\n\x1a\n") && &data[12..16] == b"IHDR"
        }
        "image/jpeg" => data.len() >= 4 && data.starts_with(b"\xff\xd8\xff"),
        "image/gif" => {
            data.len() >= 13 && (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"))
        }
        "image/webp" => data.len() >= 16 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP",
        "image/bmp" => data.len() >= 14 && data.starts_with(b"BM"),
        "image/tiff" => {
            data.len() >= 8 && (data.starts_with(b"II*\x00") || data.starts_with(b"MM\x00*"))
        }
        _ => false,
    }
}

/// Read a user-specified local image file (`<= 8 MiB`), verify format/magic bytes,
/// base64-encode as `data:<mime>;base64,...`, and return a normalized `user_upload` object.
pub fn load_local_image_attachment(
    workspace_root: &Path,
    raw_path: &str,
    id: Option<&str>,
) -> Result<Value, ProjectError> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        return Err(ProjectError::code("attachment_not_local"));
    }
    let rel = Path::new(trimmed);
    let (_ext, mime) =
        image_media_type(rel).ok_or_else(|| ProjectError::code("attachment_format_unsupported"))?;
    let candidate = if rel.is_absolute() {
        rel.to_path_buf()
    } else {
        workspace_root.join(rel)
    };
    let canon = fs::canonicalize(&candidate)
        .map_err(|e| ProjectError::new("attachment_read_failed", e.to_string()))?;
    let meta = fs::symlink_metadata(&canon)
        .map_err(|e| ProjectError::new("attachment_read_failed", e.to_string()))?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(ProjectError::code("attachment_not_regular"));
    }
    if meta.len() as usize > MAX_IMAGE_ATTACHMENT_BYTES {
        return Err(ProjectError::code("attachment_size_limit"));
    }
    let mut data = Vec::with_capacity(meta.len() as usize);
    File::open(&canon)
        .and_then(|mut f| f.read_to_end(&mut data))
        .map_err(|e| ProjectError::new("attachment_read_failed", e.to_string()))?;
    if data.is_empty() || data.len() > MAX_IMAGE_ATTACHMENT_BYTES {
        return Err(ProjectError::code("attachment_size_limit"));
    }
    if !matches_image_magic(mime, &data) {
        return Err(ProjectError::code("attachment_format_invalid"));
    }
    let b64 = base64_encode(&data);
    let data_url = format!("data:{mime};base64,{b64}");
    let name = canon
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_owned();
    let att_id = match id
        .map(str::trim)
        .filter(|s| !s.is_empty() && is_valid_input_id(s))
    {
        Some(custom) => custom.to_owned(),
        None => {
            let digest = format!("{:x}", Sha256::digest(&data));
            format!("img-{}", &digest[..16])
        }
    };
    normalize_user_upload(&json!({
        "id": att_id,
        "name": name,
        "mimeType": mime,
        "size": data.len(),
        "kind": "image",
        "dataUrl": data_url,
    }))
}

/// Extract normalized attachments carried by anchored parent messages (max 8, deduped by `id`).
pub fn attachments_from_messages(
    messages: &[Value],
    anchor_message_ids: &[String],
) -> Result<Vec<Value>, ProjectError> {
    let anchors: HashSet<&str> = anchor_message_ids.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for msg in messages {
        let Some(id) = msg["id"].as_str() else {
            continue;
        };
        if !anchors.contains(id) {
            continue;
        }
        let Some(raw) = msg["attachments"].as_array() else {
            continue;
        };
        for item in normalize_input_attachments(raw)? {
            let att_id = item["id"].as_str().unwrap_or("").to_owned();
            if seen.insert(att_id) {
                out.push(item);
                if out.len() > INPUT_ATTACHMENT_LIMIT {
                    return Err(ProjectError::code("ATTACHMENT_LIMIT"));
                }
            }
        }
    }
    Ok(out)
}

fn format_attachment_size(bytes: f64) -> String {
    if bytes < 1024.0 {
        format!("{bytes} B")
    } else if bytes < 1_048_576.0 {
        format!("{:.1} KB", (bytes / 1024.0 * 10.0).round() / 10.0)
    } else {
        format!("{:.1} MB", (bytes / 1_048_576.0 * 10.0).round() / 10.0)
    }
}

/// Project a canonical persisted `user_input` message (with optional text/image/unsupported
/// attachments) into a model-ready message matching `peer_runtime::canonical_history::user`.
pub fn project_user_message_for_model(msg: &Value) -> Option<Value> {
    if msg["role"].as_str() != Some("user") {
        return None;
    }
    let mut blocks: Vec<String> = Vec::new();
    let mut images: Vec<String> = Vec::new();
    if let Some(s) = msg["content"].as_str().filter(|s| !s.trim().is_empty()) {
        blocks.push(s.to_owned());
    }
    if let Some(atts) = msg["attachments"].as_array() {
        for a in atts {
            if !a.is_object() {
                continue;
            }
            let kind = a["kind"].as_str().unwrap_or("");
            if kind == "text" || kind == "unsupported" {
                let name = a["name"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("attachment");
                let mime = a["mimeType"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(if kind == "text" {
                        "text/plain"
                    } else {
                        "application/octet-stream"
                    });
                let bytes = a["size"].as_f64().unwrap_or(0.0).max(0.0);
                let size_str = format_attachment_size(bytes);
                let tail = if kind == "text" {
                    format!("Content:\n```\n{}\n```", a["text"].as_str().unwrap_or(""))
                } else {
                    "Content is not included because this file type is not supported yet."
                        .to_owned()
                };
                blocks.push(format!(
                    "Attached file: {name}\nMIME: {mime}\nSize: {size_str}\n{tail}"
                ));
            } else if kind == "image" {
                let u = a["dataUrl"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| a["url"].as_str().filter(|s| !s.trim().is_empty()));
                if let Some(url) = u {
                    images.push(url.to_owned());
                }
            }
        }
    }
    if let Some(extra_imgs) = msg["images"].as_array() {
        for img in extra_imgs {
            let u = img["url"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| img["dataUrl"].as_str().filter(|s| !s.trim().is_empty()));
            if let Some(url) = u
                && !images.iter().any(|existing| existing == url)
            {
                images.push(url.to_owned());
            }
        }
    }

    let joined_text = blocks.join("\n\n");
    if joined_text.is_empty() && images.is_empty() {
        return None;
    }
    if images.is_empty() {
        return Some(json!({
            "role": "user",
            "content": joined_text,
        }));
    }
    let mut parts: Vec<Value> = Vec::new();
    if !joined_text.is_empty() {
        parts.push(json!({ "type": "text", "text": joined_text }));
    }
    for url in images {
        parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
    }
    Some(json!({
        "role": "user",
        "content": parts,
    }))
}

/// Materialize `kind == "image"` data-URL attachments into regular files inside `dir` for
/// delegated worker `ConversationOptions.image_paths`.
pub fn materialize_image_attachments(
    dir: &Path,
    attachments: &[Value],
) -> Result<Vec<PathBuf>, ProjectError> {
    let mut paths = Vec::new();
    let image_items: Vec<&Value> = attachments
        .iter()
        .filter(|a| a["kind"].as_str() == Some("image"))
        .collect();
    if image_items.is_empty() {
        return Ok(paths);
    }
    fs::create_dir_all(dir).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    for (idx, att) in image_items.iter().enumerate() {
        let Some(url) = att["dataUrl"].as_str() else {
            continue;
        };
        let Some((header, b64)) = url.strip_prefix("data:").and_then(|r| r.split_once(',')) else {
            continue;
        };
        let mime = header.strip_suffix(";base64").unwrap_or("");
        let ext = match mime {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/bmp" => "bmp",
            "image/tiff" => "tiff",
            _ => continue,
        };
        let raw = base64_decode_strict(b64)?;
        let out_path = dir.join(format!("att-{}-{idx}.{ext}", uuid::Uuid::new_v4()));
        fs::write(&out_path, &raw).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        paths.push(out_path);
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_png_bytes() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&[0u8; 13]);
        bytes
    }

    #[test]
    fn normalizes_image_text_unsupported_and_rejects_oversized_or_invalid() {
        let raw_png = sample_png_bytes();
        let data_url = format!("data:image/png;base64,{}", base64_encode(&raw_png));
        let img = normalize_user_upload(&json!({
            "id": "att-1",
            "name": "shot.png",
            "mimeType": "image/png",
            "size": raw_png.len(),
            "kind": "image",
            "dataUrl": data_url,
        }))
        .unwrap();
        assert_eq!(img["kind"], "image");
        assert_eq!(img["sourceKind"], "user_upload");

        let txt = normalize_user_upload(&json!({
            "id": "att-2",
            "name": "notes.txt",
            "mimeType": "text/plain",
            "size": 5,
            "kind": "text",
            "text": "hello",
        }))
        .unwrap();
        assert_eq!(txt["text"], "hello");

        let unsup = normalize_user_upload(&json!({
            "id": "att-3",
            "name": "blob.bin",
            "mimeType": "application/octet-stream",
            "size": 12,
            "kind": "unsupported",
        }))
        .unwrap();
        assert_eq!(unsup["kind"], "unsupported");

        assert!(
            normalize_user_upload(&json!({
                "id": "bad",
                "name": "bad.png",
                "mimeType": "image/jpeg",
                "size": raw_png.len(),
                "kind": "image",
                "dataUrl": img["dataUrl"],
            }))
            .is_err()
        );
        assert!(
            normalize_user_upload(&json!({
                "id": "big",
                "name": "big.txt",
                "mimeType": "text/plain",
                "size": MAX_TEXT_ATTACHMENT_BYTES + 1,
                "kind": "text",
                "text": "x",
            }))
            .is_err()
        );
        let too_many = vec![txt.clone(); INPUT_ATTACHMENT_LIMIT + 1];
        assert_eq!(
            normalize_input_attachments(&too_many).unwrap_err().code,
            "ATTACHMENT_LIMIT"
        );
    }

    #[test]
    fn loads_local_png_projects_multimodal_history_and_materializes_files() {
        let dir = tempdir().unwrap();
        let png = sample_png_bytes();
        fs::write(dir.path().join("screen.png"), &png).unwrap();

        let att = load_local_image_attachment(dir.path(), "screen.png", Some("s1")).unwrap();
        let msg = json!({
            "id": "input-1",
            "role": "user",
            "kind": "user_input",
            "content": "What is in this screenshot?",
            "attachments": [att],
        });
        let projected = project_user_message_for_model(&msg).unwrap();
        assert_eq!(projected["role"], "user");
        let parts = projected["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image_url");

        let extracted = attachments_from_messages(&[msg], &[String::from("input-1")]).unwrap();
        assert_eq!(extracted.len(), 1);
        let mat_dir = dir.path().join("mat");
        let files = materialize_image_attachments(&mat_dir, &extracted).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(fs::read(&files[0]).unwrap(), png);
    }
}
