use super::{CoordinationError as Error, Storage};
use peer_protocol::{CoordinationReducer, JsonLimits, decode_json_bounded, javascript_json_digest};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader};

pub(super) struct Replay<'a, R> {
    pub state: Value,
    pub hash: String,
    pub head_revision: u64,
    pub head_hash: &'a str,
    pub head_seen: bool,
    pub total: u64,
    pub reducer: &'a R,
    pub blobs: Vec<(String, String)>,
    pub records: usize,
    pub minimum_format: u64,
}
impl<R: CoordinationReducer> Replay<'_, R> {
    pub fn source(
        &mut self,
        storage: &Storage<'_>,
        relative: &str,
        v2: bool,
    ) -> Result<(u64, String), Error> {
        storage.guard()?;
        let Some((file, before)) = storage.file(relative, 64 * 1024 * 1024)? else {
            return Ok((0, format!("{:x}", Sha256::digest([]))));
        };
        self.total = self
            .total
            .checked_add(before.size)
            .filter(|v| *v <= 64 * 1024 * 1024)
            .ok_or(Error::Limit)?;
        let mut reader = BufReader::with_capacity(16 * 1024, file);
        let mut line = Vec::new();
        let mut bytes = 0;
        let mut hasher = Sha256::new();
        loop {
            storage.guard()?;
            let chunk = reader.fill_buf().map_err(|_| Error::Read)?;
            if chunk.is_empty() {
                break;
            }
            let count = chunk
                .iter()
                .position(|b| *b == b'\n')
                .map_or(chunk.len(), |i| i + 1);
            let part = &chunk[..count];
            let max = if v2 { 64 * 1024 } else { 1024 * 1024 };
            if line.len().saturating_add(part.len()) > max {
                return Err(Error::Limit);
            }
            line.extend_from_slice(part);
            hasher.update(part);
            bytes += count as u64;
            let terminated = part.last() == Some(&b'\n');
            reader.consume(count);
            if terminated {
                self.line(storage, &line, v2, true)?;
                line.clear();
            }
        }
        if !line.is_empty() {
            self.line(storage, &line, v2, false)?;
        }
        if storage.token(relative)? != super::file_token(&before) || bytes != before.size {
            return Err(Error::Changed);
        }
        storage.guard()?;
        Ok((bytes, format!("{:x}", hasher.finalize())))
    }
    fn line(
        &mut self,
        storage: &Storage<'_>,
        line: &[u8],
        v2: bool,
        terminated: bool,
    ) -> Result<(), Error> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        self.records += 1;
        if self.records > 4096 {
            return Err(Error::Limit);
        }
        let mut entry = decode_json_bounded(
            line,
            JsonLimits {
                bytes: 1024 * 1024,
                nodes: 32_768,
                depth: 64,
                string_bytes: 1024 * 1024,
            },
        )
        .map_err(|e| match e {
            peer_protocol::JsonDecodeError::LimitExceeded => Error::Limit,
            _ if !terminated => Error::PartialTail,
            _ => Error::Corrupt,
        })?
        .value;
        if !entry.is_object() {
            return Err(Error::Corrupt);
        }
        let envelope_revision = entry["revision"].as_u64().ok_or(Error::Corrupt)?;
        let envelope_hash = if v2 {
            if entry["storageVersion"] != 2 || entry["previousHash"] != self.hash {
                return Err(Error::Hash);
            }
            let hash = entry
                .as_object_mut()
                .unwrap()
                .shift_remove("hash")
                .and_then(|v| v.as_str().map(str::to_owned))
                .ok_or(Error::Hash)?;
            if javascript_json_digest(&entry).map_err(|_| Error::Limit)? != hash {
                return Err(Error::Hash);
            }
            Some(hash)
        } else {
            None
        };
        if entry["kind"] == "payload_ref" {
            if !v2 {
                return Err(Error::Corrupt);
            }
            let hash = entry["payloadRef"]["hash"]
                .as_str()
                .filter(|s| super::hash_valid(s) && !s.is_empty())
                .ok_or(Error::Corrupt)?;
            let size = entry["payloadRef"]["bytes"]
                .as_u64()
                .filter(|n| *n <= 1024 * 1024)
                .ok_or(Error::Limit)?;
            let relative = format!("coordination-v2/blobs/{hash}.json");
            self.total = self
                .total
                .checked_add(size)
                .filter(|n| *n <= 64 * 1024 * 1024)
                .ok_or(Error::Limit)?;
            let token = storage.token(&relative)?;
            let bytes = crate::files::read(&storage.path(&relative)?, 1024 * 1024)?
                .ok_or(Error::PayloadMissing)?;
            if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != hash {
                return Err(Error::Hash);
            }
            if storage.token(&relative)? != token {
                return Err(Error::Changed);
            }
            self.blobs.push((relative, token));
            entry = decode_json_bounded(
                &bytes,
                JsonLimits {
                    bytes: 1024 * 1024,
                    nodes: 32_768,
                    depth: 64,
                    string_bytes: 1024 * 1024,
                },
            )
            .map_err(|_| Error::Corrupt)?
            .value;
            if !entry.is_object() || entry["kind"] == "payload_ref" {
                return Err(Error::Corrupt);
            }
            entry["revision"] = envelope_revision.into();
            entry["schemaVersion"] = 1.into();
        }
        if envelope_revision
            != self.state["revision"]
                .as_u64()
                .ok_or(Error::Corrupt)?
                .checked_add(1)
                .ok_or(Error::Corrupt)?
        {
            return Err(Error::Revision);
        }
        storage.guard()?;
        self.state = self
            .reducer
            .reduce(&self.state, &entry)
            .map_err(Error::Reducer)?;
        if self.state["revision"].as_u64() != Some(envelope_revision) {
            return Err(Error::Revision);
        }
        self.minimum_format = self
            .minimum_format
            .max(super::write::semantic_floor(&entry, &self.state));
        if let Some(hash) = envelope_hash {
            self.hash = hash;
        }
        if envelope_revision == self.head_revision {
            if self.hash != self.head_hash {
                return Err(Error::Hash);
            }
            self.head_seen = true;
        }
        Ok(())
    }
}
