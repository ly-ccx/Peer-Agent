//! Multimodal user upload admission, local image loading, and canonical history
//! attachment projection (`packages/runtime-node/src/project-agent/input-attachments.mjs`
//! and `crates/peer-runtime/src/canonical_history.rs`).

use crate::{ProjectError, atomic_write, is_valid_input_id, is_valid_workspace_id};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

pub const INPUT_ATTACHMENT_LIMIT: usize = 100;
pub const MAX_IMAGE_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TEXT_ATTACHMENT_BYTES: usize = 512 * 1024;
/// Images larger than this decoded threshold are stored out-of-line in
/// `<workspace_runtime>/attachment-blobs/<sha256>.<ext>` so JSONL logs and RPC frames
/// stay compact even with 100+ high-resolution screenshots.
pub const INLINE_IMAGE_THRESHOLD_BYTES: usize = 32 * 1024;

fn base64_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn base64_decode_strict(s: &str) -> Result<Vec<u8>, ProjectError> {
    if s.is_empty() {
        return Err(ProjectError::new(
            "INVALID_ATTACHMENT",
            "attachment image data is invalid",
        ));
    }
    STANDARD
        .decode(s)
        .map_err(|_| ProjectError::new("INVALID_ATTACHMENT", "attachment image data is invalid"))
}

fn clip_token(raw: Option<&str>, limit: usize, fallback: &str) -> String {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return fallback.to_owned();
    };
    s.chars().take(limit).collect()
}

fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn image_ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        "image/avif" => Some("avif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
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
    normalize_user_upload_with_bytes(item).map(|(value, _)| value)
}

fn normalize_user_upload_with_bytes(
    item: &Value,
) -> Result<(Value, Option<Vec<u8>>), ProjectError> {
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
                    "attachment image exceeds 32 MiB",
                ));
            }
            let decoded = base64_decode_strict(b64)?;
            if decoded.len() > MAX_IMAGE_ATTACHMENT_BYTES {
                return Err(ProjectError::new(
                    "INVALID_ATTACHMENT",
                    "attachment image exceeds 32 MiB",
                ));
            }
            Ok((
                json!({
                    "id": id,
                    "name": name,
                    "mimeType": mime_type,
                    "size": size,
                    "sourceKind": "user_upload",
                    "kind": "image",
                    "dataUrl": url,
                }),
                Some(decoded),
            ))
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
            Ok((
                json!({
                    "id": id,
                    "name": name,
                    "mimeType": mime_type,
                    "size": size,
                    "sourceKind": "user_upload",
                    "kind": "text",
                    "text": text,
                }),
                None,
            ))
        }
        Some("unsupported") => Ok((
            json!({
                "id": id,
                "name": name,
                "mimeType": mime_type,
                "size": size,
                "sourceKind": "user_upload",
                "kind": "unsupported",
            }),
            None,
        )),
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
            "attachments exceed limit of 100",
        ));
    }
    items.iter().map(normalize_user_upload).collect()
}

/// Normalize untrusted incoming user uploads and spill image attachments larger than
/// `INLINE_IMAGE_THRESHOLD_BYTES` into content-addressed raw files under
/// `<runtime_ws_root>/attachment-blobs/<sha256>.<ext>` so JSONL logs and RPC frames remain small.
pub fn persist_input_attachments(
    runtime_ws_root: &Path,
    items: &[Value],
) -> Result<Vec<Value>, ProjectError> {
    if items.len() > INPUT_ATTACHMENT_LIMIT {
        return Err(ProjectError::new(
            "ATTACHMENT_LIMIT",
            "attachments exceed limit of 100",
        ));
    }
    let mut out = Vec::with_capacity(items.len());
    for raw_item in items {
        let (item, decoded_image) = normalize_user_upload_with_bytes(raw_item)?;
        if item["kind"].as_str() == Some("image")
            && let Some(mime) = item["mimeType"].as_str()
            && let Some(ext) = image_ext_for_mime(mime)
            && let Some(raw) = decoded_image
            && raw.len() > INLINE_IMAGE_THRESHOLD_BYTES
        {
            let digest = format!("{:x}", Sha256::digest(&raw));
            let blob_path = runtime_ws_root
                .join("attachment-blobs")
                .join(format!("{digest}.{ext}"));
            if !blob_path.exists() {
                atomic_write(&blob_path, &raw)?;
            }
            out.push(json!({
                "id": item["id"],
                "name": item["name"],
                "mimeType": mime,
                "size": item["size"],
                "sourceKind": "user_upload",
                "kind": "image",
                "blobDigest": digest,
                "filePath": blob_path.to_string_lossy(),
            }));
            continue;
        }
        out.push(item);
    }
    Ok(out)
}

/// Normalize an already-persisted upload record (accepts both inline `dataUrl` images and
/// host-persisted `blobDigest` images without trusting any caller-supplied `filePath`).
fn normalize_persisted_upload(item: &Value) -> Result<Value, ProjectError> {
    let Some(obj) = item.as_object() else {
        return Err(ProjectError::new(
            "INVALID_ATTACHMENT",
            "attachment must be an object",
        ));
    };
    if obj.get("kind").and_then(Value::as_str) == Some("image")
        && obj
            .get("dataUrl")
            .and_then(Value::as_str)
            .is_none_or(|s| s.trim().is_empty())
        && let Some(digest) = obj
            .get("blobDigest")
            .and_then(Value::as_str)
            .filter(|s| is_valid_sha256_hex(s))
    {
        let size = obj
            .get("size")
            .and_then(Value::as_u64)
            .filter(|s| *s <= MAX_IMAGE_ATTACHMENT_BYTES as u64)
            .ok_or_else(|| ProjectError::new("INVALID_ATTACHMENT", "attachment size is invalid"))?
            as usize;
        let id = clip_token(obj.get("id").and_then(Value::as_str), 80, "attachment");
        let name = clip_token(obj.get("name").and_then(Value::as_str), 240, "file");
        let mime_type = clip_token(
            obj.get("mimeType").and_then(Value::as_str),
            100,
            "application/octet-stream",
        );
        if !is_valid_image_mime_subtype(&mime_type) || image_ext_for_mime(&mime_type).is_none() {
            return Err(ProjectError::new(
                "INVALID_ATTACHMENT",
                "attachment image data is invalid",
            ));
        }
        let mut out = json!({
            "id": id,
            "name": name,
            "mimeType": mime_type,
            "size": size,
            "sourceKind": "user_upload",
            "kind": "image",
            "blobDigest": digest,
        });
        if let Some(fp) = obj
            .get("filePath")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            out["filePath"] = json!(fp);
        }
        return Ok(out);
    }
    normalize_user_upload(item)
}

/// Resolve an image attachment's `data:<mime>;base64,...` URL, loading verified raw bytes from
/// `<data_home>/project-runtime/<workspace_id>/attachment-blobs/<blobDigest>.<ext>` when stored
/// out-of-line. Never trusts arbitrary `filePath` values from JSON.
pub fn resolve_workspace_image_data_url(
    data_home: &Path,
    workspace_id: &str,
    att: &Value,
) -> Option<String> {
    if let Some(url) = att["dataUrl"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| att["url"].as_str().filter(|s| !s.trim().is_empty()))
    {
        return Some(url.to_owned());
    }
    let blob_path = verified_workspace_blob_path(data_home, workspace_id, att)?;
    let mime = att["mimeType"].as_str()?;
    let bytes = read_verified_blob_bytes(&blob_path, att["blobDigest"].as_str()?)?;
    Some(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

fn verified_workspace_blob_path(
    data_home: &Path,
    workspace_id: &str,
    att: &Value,
) -> Option<PathBuf> {
    let ws = workspace_id.trim();
    if !is_valid_workspace_id(ws) {
        return None;
    }
    let digest = att["blobDigest"]
        .as_str()
        .filter(|s| is_valid_sha256_hex(s))?;
    let mime = att["mimeType"].as_str()?;
    let ext = image_ext_for_mime(mime)?;
    Some(
        data_home
            .join("project-runtime")
            .join(ws)
            .join("attachment-blobs")
            .join(format!("{digest}.{ext}")),
    )
}

fn read_verified_blob_bytes(path: &Path, expected_digest: &str) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() as usize > MAX_IMAGE_ATTACHMENT_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_ATTACHMENT_BYTES {
        return None;
    }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    (actual == expected_digest).then_some(bytes)
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
    Ok(json!({
        "id": clip_token(Some(&att_id), 80, "attachment"),
        "name": clip_token(Some(&name), 240, "file"),
        "mimeType": clip_token(Some(mime), 100, "application/octet-stream"),
        "size": data.len(),
        "sourceKind": "user_upload",
        "kind": "image",
        "dataUrl": data_url,
    }))
}

/// Extract normalized attachments carried by anchored parent messages (deduped by `id`).
pub fn attachments_from_messages(
    messages: &[Value],
    anchor_message_ids: &[String],
) -> Result<Vec<Value>, ProjectError> {
    attachments_from_messages_inner(messages, anchor_message_ids, false)
}

/// Extract persisted attachments (including out-of-line `blobDigest` image records) carried by
/// anchored parent messages (deduped by `id`).
pub fn attachments_from_messages_persisted(
    messages: &[Value],
    anchor_message_ids: &[String],
) -> Result<Vec<Value>, ProjectError> {
    attachments_from_messages_inner(messages, anchor_message_ids, true)
}

fn attachments_from_messages_inner(
    messages: &[Value],
    anchor_message_ids: &[String],
    allow_blob_refs: bool,
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
        if raw.len() > INPUT_ATTACHMENT_LIMIT {
            return Err(ProjectError::code("ATTACHMENT_LIMIT"));
        }
        for raw_item in raw {
            let item = if allow_blob_refs {
                normalize_persisted_upload(raw_item)?
            } else {
                normalize_user_upload(raw_item)?
            };
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
    project_user_message_for_model_inner(None, msg)
}

/// Project a canonical persisted `user_input` message into a model-ready message, hydrating
/// out-of-line workspace image blobs (`blobDigest`) into data URLs on demand.
pub fn project_user_message_for_model_in_workspace(
    data_home: &Path,
    workspace_id: &str,
    msg: &Value,
) -> Option<Value> {
    project_user_message_for_model_inner(Some((data_home, workspace_id)), msg)
}

fn project_user_message_for_model_inner(
    workspace_ctx: Option<(&Path, &str)>,
    msg: &Value,
) -> Option<Value> {
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
                let resolved = match workspace_ctx {
                    Some((home, ws)) => resolve_workspace_image_data_url(home, ws, a),
                    None => a["dataUrl"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                        .or_else(|| a["url"].as_str().filter(|s| !s.trim().is_empty()))
                        .map(str::to_owned),
                };
                if let Some(url) = resolved {
                    images.push(url);
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
    materialize_image_attachments_inner(None, dir, attachments)
}

/// Materialize `kind == "image"` attachments (both inline `dataUrl` and out-of-line `blobDigest`
/// files) into regular files inside `dir` for delegated worker `ConversationOptions.image_paths`.
pub fn materialize_image_attachments_in_workspace(
    data_home: &Path,
    workspace_id: &str,
    dir: &Path,
    attachments: &[Value],
) -> Result<Vec<PathBuf>, ProjectError> {
    materialize_image_attachments_inner(Some((data_home, workspace_id)), dir, attachments)
}

fn materialize_image_attachments_inner(
    workspace_ctx: Option<(&Path, &str)>,
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
        if let Some(url) = att["dataUrl"].as_str().filter(|s| !s.trim().is_empty()) {
            let Some((header, b64)) = url.strip_prefix("data:").and_then(|r| r.split_once(','))
            else {
                continue;
            };
            let mime = header.strip_suffix(";base64").unwrap_or("");
            let Some(ext) = image_ext_for_mime(mime) else {
                continue;
            };
            let raw = base64_decode_strict(b64)?;
            let out_path = dir.join(format!("att-{}-{idx}.{ext}", uuid::Uuid::new_v4()));
            fs::write(&out_path, &raw).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
            paths.push(out_path);
            continue;
        }
        if let Some((home, ws)) = workspace_ctx
            && let Some(blob_path) = verified_workspace_blob_path(home, ws, att)
            && let Some(digest) = att["blobDigest"].as_str()
            && let Some(ext) = att["mimeType"].as_str().and_then(image_ext_for_mime)
            && let Some(raw) = read_verified_blob_bytes(&blob_path, digest)
        {
            let out_path = dir.join(format!("att-{}-{idx}.{ext}", uuid::Uuid::new_v4()));
            fs::write(&out_path, &raw).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
            paths.push(out_path);
        }
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

    #[test]
    fn persists_large_image_out_of_line_and_projects_or_materializes_from_workspace_blob() {
        let dir = tempdir().unwrap();
        let data_home = dir.path();
        let ws = "ws-large-img";
        let ws_root = data_home.join("project-runtime").join(ws);

        let mut large_png = sample_png_bytes();
        large_png.resize(INLINE_IMAGE_THRESHOLD_BYTES + 4096, 0x42);
        let data_url = format!("data:image/png;base64,{}", base64_encode(&large_png));

        let raw_att = json!({
            "id": "att-big-1",
            "name": "8k-shot.png",
            "mimeType": "image/png",
            "size": large_png.len(),
            "kind": "image",
            "dataUrl": data_url,
        });

        let persisted = persist_input_attachments(&ws_root, &[raw_att]).unwrap();
        assert_eq!(persisted.len(), 1);
        assert!(persisted[0].get("dataUrl").is_none());
        let digest = persisted[0]["blobDigest"].as_str().unwrap();
        let file_path = PathBuf::from(persisted[0]["filePath"].as_str().unwrap());
        assert!(file_path.exists());
        assert_eq!(fs::read(&file_path).unwrap(), large_png);

        let msg = json!({
            "id": "input-big-1",
            "role": "user",
            "kind": "user_input",
            "content": "inspect 8k image",
            "attachments": persisted,
        });
        let projected = project_user_message_for_model_in_workspace(data_home, ws, &msg).unwrap();
        let parts = projected["content"].as_array().unwrap();
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], data_url);

        let extracted =
            attachments_from_messages_persisted(&[msg], &[String::from("input-big-1")]).unwrap();
        assert_eq!(extracted.len(), 1);
        let mat_dir = dir.path().join("mat-out");
        let files = materialize_image_attachments_in_workspace(data_home, ws, &mat_dir, &extracted)
            .unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(fs::read(&files[0]).unwrap(), large_png);

        // Corrupting the blob on disk fails sha256 verification and refuses to return stale bytes.
        fs::write(&file_path, b"corrupted").unwrap();
        assert!(
            resolve_workspace_image_data_url(
                data_home,
                ws,
                &json!({ "kind": "image", "mimeType": "image/png", "blobDigest": digest })
            )
            .is_none()
        );
    }
}
