//! Existing healthy-v2 writer promotion. This installs a physical legacy-path
//! barrier, not a stop receipt or permission to execute/recover tasks. Canonical
//! v2 journal/head validation and unknown reconciliation remain separate gates.
use crate::{LeaseToken, StoreError};
use serde_json::{Value, json};
use std::{fmt, sync::atomic::AtomicBool};

mod storage;
use storage::{ContentProof, Storage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FenceError {
    Store(StoreError),
    Invalid,
    Unsupported,
    Changed,
    LegacyChanged,
    Limit,
}
impl FenceError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Store(error) => error.code(),
            Self::Invalid => "coordination_fence_invalid",
            Self::Unsupported => "coordination_schema_unsupported",
            Self::Changed => "coordination_read_changed",
            Self::LegacyChanged => "coordination_legacy_changed",
            Self::Limit => "coordination_fence_resource_limit",
        }
    }
}
impl From<StoreError> for FenceError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl fmt::Display for FenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for FenceError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FenceOutcome {
    NoV2Manifest,
    AlreadyProtected,
    Promoted,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FenceStep {
    Prepared,
    BaselineCopied,
    LegacyArchived,
    WriterFenced,
    HeadPublished,
    Published,
}
impl FenceStep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::BaselineCopied => "baseline-copied",
            Self::LegacyArchived => "legacy-archived",
            Self::WriterFenced => "writer-fenced",
            Self::HeadPublished => "head-published",
            Self::Published => "published",
        }
    }
}

/// Uses the held Host lease's own workspace path. Does not create v2 state,
/// parse/replay task events, release the lease or attest a stopped execution.
/// Hash/copy work uses 256 KiB chunks and a 2 GiB source scan limit.
/// The Host must serialize prepare per workspace and complete canonical v2
/// reducer/head validation before this promotion. This physical storage port
/// does not substitute for that prepare or execution admission.
pub fn protect_coordination_writer(
    lease: &LeaseToken,
    cancelled: Option<&AtomicBool>,
) -> Result<FenceOutcome, FenceError> {
    protect(lease, cancelled, &mut |_| Ok(()))
}
#[cfg(feature = "test-fixtures")]
pub fn protect_coordination_writer_fixture(
    lease: &LeaseToken,
    cancelled: Option<&AtomicBool>,
    mut observer: impl FnMut(FenceStep) -> Result<(), FenceError>,
) -> Result<FenceOutcome, FenceError> {
    protect(lease, cancelled, &mut observer)
}

fn floor(value: &Value) -> Result<u64, FenceError> {
    let reader = value["minimumReaderVersion"]
        .as_u64()
        .ok_or(FenceError::Unsupported)?;
    if value["schemaVersion"].as_u64() != Some(2)
        || ![2, 3, 4, 5, 6, 7, 8, 9, 11, 12].contains(&reader)
        || value["minimumWriterVersion"].as_u64() != Some(reader)
        || value["legacyFile"].as_str() != Some("coordination.jsonl")
        || value["generation"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 256)
        || value["legacyVersion"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 1024)
    {
        return Err(FenceError::Unsupported);
    }
    Ok(reader)
}
fn check_head(manifest: &Value, head: &Value) -> Result<(), FenceError> {
    if !head.is_object()
        || head["generation"] != manifest["generation"]
        || head["legacyVersion"] != manifest["legacyVersion"]
    {
        return Err(FenceError::Changed);
    }
    Ok(())
}
fn final_manifest(intent: &Value, frozen: &ContentProof) -> Value {
    let mut next = intent["manifest"].clone();
    next["legacyVersion"] = frozen.version.clone().into();
    next["minimumReaderVersion"] = 3.into();
    next["minimumWriterVersion"] = 3.into();
    next["frozenLegacyFile"] = "baseline.jsonl".into();
    next
}
fn final_head(intent: &Value, frozen: &ContentProof) -> Value {
    let mut next = intent["head"].clone();
    next["legacyVersion"] = frozen.version.clone().into();
    next
}
fn proof(value: &Value) -> Result<ContentProof, FenceError> {
    let proof: ContentProof =
        serde_json::from_value(value.clone()).map_err(|_| FenceError::Invalid)?;
    if proof.version.is_empty()
        || proof.version.len() > 1024
        || proof.bytes > storage::MAX_BASELINE_BYTES
        || proof.sha256.len() != 64
        || !proof
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(FenceError::Invalid);
    }
    if proof.version == "missing"
        && (proof.bytes != 0 || proof.sha256 != ContentProof::missing().sha256)
    {
        return Err(FenceError::Invalid);
    }
    Ok(proof)
}
fn check_seal(
    storage: &Storage<'_>,
    manifest: &Value,
    original: Option<&ContentProof>,
) -> Result<(), FenceError> {
    let Some(seal) = storage.json("coordination-v2/legacy-seal.json")? else {
        return Ok(());
    };
    if seal["schemaVersion"].as_u64() != Some(1)
        || seal["generation"] != manifest["generation"]
        || seal["legacyVersion"] != manifest["legacyVersion"]
        || seal["bytes"].as_u64().is_none()
        || seal["sha256"].as_str().is_none_or(|s| {
            s.len() != 64
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err(FenceError::Invalid);
    }
    if let Some(original) = original
        && (seal["bytes"].as_u64() != Some(original.bytes)
            || seal["sha256"].as_str() != Some(&original.sha256))
    {
        return Err(FenceError::LegacyChanged);
    }
    Ok(())
}
fn validate_intent(intent: &Value) -> Result<(), FenceError> {
    let id = intent["id"].as_str().ok_or(FenceError::Invalid)?;
    if uuid::Uuid::parse_str(id).is_err()
        || id.len() != 36
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
        || intent["schemaVersion"].as_u64() != Some(1)
        || intent["archive"].as_str() != Some(&format!(".coordination-fence/{id}"))
        || !matches!(intent["status"].as_str(), Some("prepared" | "complete"))
        || floor(&intent["manifest"])? != 2
    {
        return Err(FenceError::Invalid);
    }
    check_head(&intent["manifest"], &intent["head"])?;
    proof(&intent["original"])?;
    if let Some(frozen) = intent.get("frozen") {
        proof(frozen)?;
    }
    Ok(())
}
fn check_live_metadata(storage: &Storage<'_>, intent: &Value) -> Result<(), FenceError> {
    let manifest = storage
        .json("coordination-v2/manifest.json")?
        .ok_or(FenceError::Changed)?;
    let head = storage
        .json("coordination-v2/head.json")?
        .ok_or(FenceError::Changed)?;
    let is_original = manifest == intent["manifest"] && head == intent["head"];
    let permitted = if let Some(frozen) = intent.get("frozen") {
        let frozen = proof(frozen)?;
        let next_manifest = final_manifest(intent, &frozen);
        let next_head = final_head(intent, &frozen);
        (manifest == intent["manifest"] && head == next_head)
            || (manifest == next_manifest && head == next_head)
    } else {
        false
    };
    if !is_original && !permitted {
        return Err(FenceError::Changed);
    }
    Ok(())
}

fn protect(
    lease: &LeaseToken,
    cancelled: Option<&AtomicBool>,
    observer: &mut dyn FnMut(FenceStep) -> Result<(), FenceError>,
) -> Result<FenceOutcome, FenceError> {
    let storage = Storage::new(lease, cancelled)?;
    storage.guard()?;
    let Some(manifest) = storage.json("coordination-v2/manifest.json")? else {
        return Ok(FenceOutcome::NoV2Manifest);
    };
    let mut intent = if let Some(intent) = storage.json("coordination-fence.json")? {
        validate_intent(&intent)?;
        if intent["status"].as_str() == Some("complete") {
            return already_protected(&storage, &manifest);
        }
        check_live_metadata(&storage, &intent)?;
        intent
    } else {
        if floor(&manifest)? >= 3 {
            return already_protected(&storage, &manifest);
        }
        let head = storage
            .json("coordination-v2/head.json")?
            .ok_or(FenceError::Changed)?;
        check_head(&manifest, &head)?;
        if storage.token("coordination.jsonl")?
            != manifest["legacyVersion"]
                .as_str()
                .ok_or(FenceError::Invalid)?
        {
            return Err(FenceError::LegacyChanged);
        }
        let original = storage.hash_or_missing("coordination.jsonl")?;
        check_seal(&storage, &manifest, Some(&original))?;
        if storage.token("coordination.jsonl")? != original.version {
            return Err(FenceError::Changed);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let archive = format!(".coordination-fence/{id}");
        storage.mkdir(".coordination-fence")?;
        storage.mkdir_new(&archive)?;
        for name in ["manifest.json", "head.json", "legacy-seal.json"] {
            if storage.exists(&format!("coordination-v2/{name}"))? {
                storage.copy(
                    &format!("coordination-v2/{name}"),
                    &format!("{archive}/{name}"),
                    64 * 1024,
                )?;
            }
        }
        // Source changes while archiving cannot become the recorded intent.
        if storage.json("coordination-v2/manifest.json")?.as_ref() != Some(&manifest)
            || storage.json("coordination-v2/head.json")?.as_ref() != Some(&head)
        {
            return Err(FenceError::Changed);
        }
        let intent = json!({"schemaVersion":1,"id":id,"archive":archive,"status":"prepared","original":original,"manifest":manifest,"head":head});
        storage.publish("coordination-fence.json", &intent, &[None])?;
        observer(FenceStep::Prepared)?;
        intent
    };
    let original = proof(&intent["original"])?;
    if intent.get("frozen").is_none() {
        if storage.token("coordination.jsonl")? != original.version {
            return Err(FenceError::Changed);
        }
        if !storage.exists("coordination-v2/baseline.jsonl")? {
            if original.version == "missing" {
                storage.empty("coordination-v2/baseline.jsonl")?;
            } else {
                storage.copy(
                    "coordination.jsonl",
                    "coordination-v2/baseline.jsonl",
                    storage::MAX_BASELINE_BYTES,
                )?;
            }
        }
        let frozen = storage.hash("coordination-v2/baseline.jsonl")?;
        if frozen.bytes != original.bytes || frozen.sha256 != original.sha256 {
            return Err(FenceError::Changed);
        }
        let previous = intent.clone();
        intent["frozen"] = serde_json::to_value(frozen).map_err(|_| FenceError::Invalid)?;
        storage.publish("coordination-fence.json", &intent, &[Some(&previous)])?;
        observer(FenceStep::BaselineCopied)?;
    }
    let frozen = proof(&intent["frozen"])?;
    let content = storage.hash("coordination-v2/baseline.jsonl")?;
    if content != frozen || content.bytes != original.bytes || content.sha256 != original.sha256 {
        return Err(FenceError::Changed);
    }
    let archive = intent["archive"].as_str().ok_or(FenceError::Invalid)?;
    let moved = format!("{archive}/coordination.jsonl");
    if original.version == "missing" {
        if storage.exists("coordination.jsonl")? && !storage.is_directory("coordination.jsonl")? {
            return Err(FenceError::Changed);
        }
    } else {
        if !storage.exists(&moved)? {
            if storage.token("coordination.jsonl")? != original.version {
                return Err(FenceError::Changed);
            }
            storage.rename("coordination.jsonl", &moved)?;
            observer(FenceStep::LegacyArchived)?;
        }
        let archived = storage.hash(&moved)?;
        if archived.bytes != original.bytes || archived.sha256 != original.sha256 {
            return Err(FenceError::Changed);
        }
    }
    storage.mkdir("coordination.jsonl")?;
    observer(FenceStep::WriterFenced)?;
    check_live_metadata(&storage, &intent)?;
    let seal = json!({"schemaVersion":1,"generation":intent["manifest"]["generation"],"legacyVersion":content.version,"bytes":content.bytes,"sha256":content.sha256});
    let old_seal = storage.json(&format!("{archive}/legacy-seal.json"))?;
    storage.publish(
        "coordination-v2/legacy-seal.json",
        &seal,
        &[old_seal.as_ref(), Some(&seal)],
    )?;
    let head = final_head(&intent, &frozen);
    storage.publish(
        "coordination-v2/head.json",
        &head,
        &[Some(&intent["head"]), Some(&head)],
    )?;
    observer(FenceStep::HeadPublished)?;
    check_live_metadata(&storage, &intent)?;
    let manifest = final_manifest(&intent, &frozen);
    storage.publish(
        "coordination-v2/manifest.json",
        &manifest,
        &[Some(&intent["manifest"]), Some(&manifest)],
    )?;
    observer(FenceStep::Published)?;
    check_live_metadata(&storage, &intent)?;
    let previous = intent.clone();
    intent["status"] = "complete".into();
    storage.publish("coordination-fence.json", &intent, &[Some(&previous)])?;
    Ok(FenceOutcome::Promoted)
}
fn already_protected(storage: &Storage<'_>, manifest: &Value) -> Result<FenceOutcome, FenceError> {
    if floor(manifest)? < 3
        || manifest["frozenLegacyFile"].as_str() != Some("baseline.jsonl")
        || !storage.is_directory("coordination.jsonl")?
    {
        return Err(FenceError::Invalid);
    }
    let head = storage
        .json("coordination-v2/head.json")?
        .ok_or(FenceError::Changed)?;
    check_head(manifest, &head)?;
    storage
        .file(
            "coordination-v2/baseline.jsonl",
            storage::MAX_BASELINE_BYTES,
        )?
        .ok_or(FenceError::LegacyChanged)?;
    check_seal(storage, manifest, None)?;
    // This checks the existing physical barrier only; v2 prepare must still
    // verify canonical hashes/head, relocation proofs and execution state.
    Ok(FenceOutcome::AlreadyProtected)
}
