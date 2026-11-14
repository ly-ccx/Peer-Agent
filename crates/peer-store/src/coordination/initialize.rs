use super::{
    CoordinationError as Error, CoordinationSnapshot, CoordinationStore, Storage, replay::Replay,
    segments,
};
use peer_protocol::CoordinationReducer;
use serde_json::json;
use std::sync::atomic::AtomicBool;
impl CoordinationStore {
    /// Explicit Host-owned initialization. Reads/replays the original v1 journal
    /// before writing any v2 authority. Unsupported or conflicting state is retained.
    pub fn initialize(
        &mut self,
        reducer: &impl CoordinationReducer,
        cancel: Option<&AtomicBool>,
    ) -> Result<CoordinationSnapshot, Error> {
        let storage = Storage::new(&self.lease, cancel)?;
        storage.guard()?;
        if storage.json("coordination-v2/manifest.json")?.is_some() {
            return self.prepare(reducer, cancel);
        }
        if storage.exists("coordination-fence.json")?
            || storage.exists("coordination-recovery.json")?
            || storage.is_directory("coordination.jsonl")?
            || !segments(&storage)?.is_empty()
        {
            return Err(Error::Missing);
        }
        let v2 = storage.path("coordination-v2")?;
        match std::fs::read_dir(v2) {
            Ok(entries) => {
                for (i, entry) in entries.enumerate() {
                    if i >= 4096 {
                        return Err(Error::Limit);
                    }
                    let entry = entry.map_err(|_| Error::Read)?;
                    if ![
                        std::ffi::OsStr::new("segments"),
                        std::ffi::OsStr::new("head.json"),
                    ]
                    .contains(&entry.file_name().as_os_str())
                    {
                        return Err(Error::Missing);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(Error::Read),
        }
        match std::fs::read_dir(storage.path("coordination-v2/segments")?) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    return Err(Error::Missing);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(Error::Read),
        }
        let legacy_token = storage.token("coordination.jsonl")?;
        let mut replay = Replay {
            state: json!({"revision":0,"events":{},"works":{},"deliveries":{}}),
            hash: String::new(),
            head_revision: 0,
            head_hash: "",
            head_seen: true,
            total: 0,
            reducer,
            blobs: Vec::new(),
            records: 0,
            minimum_format: 2,
        };
        replay.source(&storage, "coordination.jsonl", false)?;
        if replay.minimum_format > 2 {
            return Err(Error::Schema);
        }
        let existing = storage.json("coordination-v2/head.json")?;
        let generation = if let Some(old) = &existing {
            if old["legacyVersion"] != legacy_token
                || old["revision"] != replay.state["revision"]
                || old["hash"] != replay.hash
                || old["minimumWriterVersion"].as_u64().unwrap_or(2) != 2
            {
                return Err(Error::Changed);
            }
            old["generation"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or(Error::Corrupt)?
                .to_owned()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        storage.mkdir("coordination-v2")?;
        storage.mkdir("coordination-v2/segments")?;
        let mut head = existing.clone().unwrap_or(json!({}));
        head["generation"] = json!(generation);
        head["legacyVersion"] = json!(legacy_token);
        head["minimumWriterVersion"] = json!(2);
        head["revision"] = replay.state["revision"].clone();
        head["hash"] = json!(replay.hash);
        if storage.token("coordination.jsonl")? != legacy_token {
            return Err(Error::Changed);
        }
        storage.publish("coordination-v2/head.json", &head, &[existing.as_ref()])?;
        if storage.token("coordination.jsonl")? != legacy_token {
            return Err(Error::Changed);
        }
        let manifest = json!({"schemaVersion":2,"minimumReaderVersion":2,"minimumWriterVersion":2,"generation":generation,"legacyFile":"coordination.jsonl","legacyVersion":legacy_token});
        storage.publish("coordination-v2/manifest.json", &manifest, &[None])?;
        self.prepare(reducer, cancel)
    }
}
