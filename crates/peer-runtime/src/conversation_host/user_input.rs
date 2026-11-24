//! Capture local images explicitly selected by the caller into one canonical
//! user message. Model output never reaches this file-reading seam.
use super::{CancellationToken, HostError};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs::{File, Metadata},
    io::Read,
    path::{Path, PathBuf},
};

const MAX_IMAGES: usize = 128;

pub(super) async fn message(
    workspace: &Path,
    prompt: &str,
    paths: &[PathBuf],
    at: &str,
    cancel: &CancellationToken,
) -> Result<Value, HostError> {
    let id = format!("message-{}", uuid::Uuid::new_v4());
    let mut message = json!({"id":id,"role":"user","content":prompt,"createdAt":at});
    if !paths.is_empty() {
        if paths.len() > MAX_IMAGES {
            return Err(HostError("attachment_count_limit"));
        }
        let workspace = workspace.to_owned();
        let paths = paths.to_owned();
        let cancel = cancel.clone();
        let budget = crate::model::REQUEST_BYTES.saturating_sub(prompt.len());
        let images =
            tokio::task::spawn_blocking(move || capture(&workspace, &paths, budget, &cancel))
                .await
                .map_err(|_| HostError("attachment_read_failed"))??;
        message["attachments"] = Value::Array(images.into_iter().enumerate().map(|(index, image)| {
            let index = index + 1;
            json!({"id":format!("{id}-image-{index}"),"name":format!("image-{index}.{}",image.extension),
                "mimeType":image.mime,"size":image.size,"kind":"image","dataUrl":image.url})
        }).collect());
    }
    Ok(message)
}

struct Image {
    extension: &'static str,
    mime: &'static str,
    size: usize,
    url: String,
}

fn capture(
    workspace: &Path,
    paths: &[PathBuf],
    mut budget: usize,
    cancel: &CancellationToken,
) -> Result<Vec<Image>, HostError> {
    let mut images = Vec::with_capacity(paths.len());
    for path in paths {
        check_cancel(cancel)?;
        if path.as_os_str().is_empty() || path.to_string_lossy().contains("://") {
            return Err(HostError("attachment_not_local"));
        }
        let (extension, mime) =
            media_type(path).ok_or(HostError("attachment_format_unsupported"))?;
        let prefix = format!("data:{mime};base64,");
        let max_bytes = budget.saturating_sub(prefix.len()) / 4 * 3;
        let path = std::fs::canonicalize(workspace.join(path))
            .map_err(|_| HostError("attachment_read_failed"))?;
        let data = read_regular(&path, max_bytes, cancel)?;
        if !matches_file_format(mime, &data) {
            return Err(HostError("attachment_format_invalid"));
        }
        let size = data.len();
        let mut url = prefix;
        STANDARD.encode_string(data, &mut url);
        budget -= url.len();
        images.push(Image {
            extension,
            mime,
            size,
            url,
        });
    }
    check_cancel(cancel)?;
    Ok(images)
}

fn check_cancel(cancel: &CancellationToken) -> Result<(), HostError> {
    if cancel.is_cancelled() {
        Err(HostError("CANCELLED"))
    } else {
        Ok(())
    }
}

fn file_stamp(meta: &Metadata) -> (u64, u64, u64, i128, i128) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (
            meta.dev(),
            meta.ino(),
            meta.len(),
            i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
            i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()),
        )
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        (
            u64::from(meta.file_attributes()),
            meta.creation_time(),
            meta.len(),
            i128::from(meta.last_write_time()),
            i128::from(meta.creation_time()),
        )
    }
}

fn open_attachment_nofollow(path: &Path) -> Result<File, HostError> {
    #[cfg(unix)]
    {
        use rustix::fs::{Mode, OFlags};
        let fd = rustix::fs::open(
            path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| HostError("attachment_read_failed"))?;
        Ok(File::from(fd))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| HostError("attachment_read_failed"))?;
        let meta = file
            .metadata()
            .map_err(|_| HostError("attachment_read_failed"))?;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Err(HostError("attachment_not_regular"));
        }
        Ok(file)
    }
}

fn read_regular(
    path: &Path,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, HostError> {
    let named = || std::fs::symlink_metadata(path).map_err(|_| HostError("attachment_read_failed"));
    let original = named()?;
    if !original.is_file() {
        return Err(HostError("attachment_not_regular"));
    }
    let mut file = open_attachment_nofollow(path)?;
    let metadata = |file: &File| {
        file.metadata()
            .map_err(|_| HostError("attachment_read_failed"))
    };
    let before = metadata(&file)?;
    if !before.is_file() || file_stamp(&original) != file_stamp(&before) {
        return Err(HostError("attachment_source_changed"));
    }
    if before.len() == 0 {
        return Err(HostError("attachment_empty"));
    }
    let size = usize::try_from(before.len())
        .ok()
        .filter(|size| *size <= limit)
        .ok_or(HostError("attachment_size_limit"))?;
    let mut body = Vec::with_capacity(size);
    let mut chunk = [0; 8192];
    loop {
        check_cancel(cancel)?;
        let n = match file.read(&mut chunk) {
            Ok(n) => n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(HostError("attachment_read_failed")),
        };
        if n == 0 {
            break;
        }
        if body.len() + n > size {
            return Err(HostError("attachment_source_changed"));
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let after = metadata(&file)?;
    if body.len() != size
        || file_stamp(&before) != file_stamp(&after)
        || named().ok().as_ref().map(file_stamp) != Some(file_stamp(&before))
    {
        return Err(HostError("attachment_source_changed"));
    }
    Ok(body)
}

fn media_type(path: &Path) -> Option<(&'static str, &'static str)> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "png" => ("png", "image/png"),
            "jpg" | "jpeg" => ("jpg", "image/jpeg"),
            "gif" => ("gif", "image/gif"),
            "webp" => ("webp", "image/webp"),
            "bmp" => ("bmp", "image/bmp"),
            "tif" | "tiff" => ("tiff", "image/tiff"),
            "heic" => ("heic", "image/heic"),
            "heif" => ("heif", "image/heif"),
            "avif" => ("avif", "image/avif"),
            _ => return None,
        },
    )
}

fn matches_file_format(mime: &str, data: &[u8]) -> bool {
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
        "image/avif" => iso_media(data, &[b"avif", b"avis"]),
        "image/heic" => iso_media(data, &[b"heic", b"heix", b"hevc", b"hevx"]),
        "image/heif" => iso_media(
            data,
            &[b"mif1", b"msf1", b"heic", b"heix", b"hevc", b"hevx"],
        ),
        _ => false,
    }
}

fn iso_media(data: &[u8], expected: &[&[u8; 4]]) -> bool {
    if data.len() < 16 || &data[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes(data[..4].try_into().unwrap()) as usize;
    let Some(header) = data.get(..size).filter(|box_bytes| box_bytes.len() >= 16) else {
        return false;
    };
    let (compatible, trailing) = header[16..].as_chunks::<4>();
    trailing.is_empty()
        && std::iter::once(&header[8..12])
            .chain(compatible.iter().map(|brand| brand.as_slice()))
            .any(|brand| expected.iter().any(|value| brand == *value))
}
