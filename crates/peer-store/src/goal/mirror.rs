//! A narrow Host fact mirror, not arbitrary Goal patch/CRUD. The canonical
//! journal/ledger remains fact owner. A shared TS/native root lock serializes
//! body/index/sidecar commits; unknown fields and progress files are retained.
use super::*;
use crate::{DirectoryLock, LeaseToken, durable_jsonl as log};
use peer_protocol::{
    SessionExecutionIdentity, decode_json_bounded, normalize_session_execution_identity,
};
use serde_json::json;
use std::time::Duration;
const MAX_BODY: usize = 8 * 1024 * 1024;
pub enum GoalExecutionFact<'a> {
    SessionControl(&'a Value),
    ClaimClosure(&'a Value),
    /// Actual Host-settled pause. Never Goal acceptance or model-reported done.
    ManagedPause(&'a Value),
}
pub struct GoalMirrorCommit {
    pub source_revision: String,
    pub changed: bool,
}
pub struct GoalMirrorTransaction<'a> {
    _lock: DirectoryLock,
    lease: &'a LeaseToken,
    directory: PathBuf,
    plan_id: String,
    execution: SessionExecutionIdentity,
    source_revision: String,
    raw: Value,
    facts: Value,
    index: Vec<Value>,
    index_revision: String,
}
fn decode(bytes: &[u8], max: usize) -> Result<Value, GoalError> {
    decode_json_bounded(
        bytes,
        JsonLimits {
            bytes: max,
            nodes: 65536,
            depth: 64,
            string_bytes: max,
        },
    )
    .map(|v| v.value)
    .map_err(|e| match e {
        peer_protocol::JsonDecodeError::LimitExceeded => GoalError::Limit,
        _ => GoalError::Invalid,
    })
}
fn encode(value: &Value) -> Result<Vec<u8>, GoalError> {
    fn numbers(v: &Value) -> bool {
        match v {
            Value::Number(n) => n.as_f64().is_some_and(|f| {
                f.is_finite() && (f.fract() != 0.0 || f.abs() <= 9_007_199_254_740_991.0)
            }),
            Value::Array(a) => a.iter().all(numbers),
            Value::Object(m) => m.values().all(numbers),
            _ => true,
        }
    }
    if !numbers(value) {
        return Err(GoalError::Projection("GOAL_VALUE_UNREPRESENTABLE"));
    }
    let bytes = serde_json::to_vec(value).map_err(|_| GoalError::Invalid)?;
    if bytes.len() > MAX_BODY {
        return Err(GoalError::Limit);
    }
    Ok(bytes)
}
impl GoalStore {
    /// Preflight BEFORE a ledger closure. Holding the guard spans that existing
    /// transaction and its Goal mirror; a crash is reconciled from the ledger's
    /// original closure, never a second recovery journal or a tool replay.
    pub fn prepare_execution_mirror<'a>(
        &self,
        lease: &'a LeaseToken,
        id: &str,
        expected_revision: &str,
        projector: &impl GoalFactProjector,
        cancel: Option<&AtomicBool>,
    ) -> Result<GoalMirrorTransaction<'a>, GoalError> {
        if !valid_id(id, false) {
            return Err(GoalError::Invalid);
        }
        if !lease.holds()? {
            return Err(StoreError::LeaseOwnershipLost.into());
        }
        let lock = DirectoryLock::acquire(
            &self.directory.join("index.jsonl"),
            Duration::from_millis(100),
            cancel,
        )?;
        let snapshot = self.read(id, projector, cancel)?;
        if snapshot.source_revision != expected_revision {
            return Err(GoalError::Changed);
        }
        let execution = normalize_session_execution_identity(&snapshot.facts["execution"])
            .ok_or(GoalError::Invalid)?;
        if snapshot.facts["delegationOrigin"]["workspaceId"].as_str() != Some(lease.workspace_id()?)
        {
            return Err(StoreError::OutOfScope.into());
        }
        let raw = decode(
            &files::read(&self.directory.join(format!("{id}.json")), MAX_BODY)?
                .ok_or(StoreError::NotFound)?,
            MAX_BODY,
        )?;
        if raw["planId"] != id || !raw["delegationOrigin"].is_object() {
            return Err(GoalError::Invalid);
        }
        let index_path = self.directory.join("index.jsonl");
        let index_before = files::identity(&index_path)?.ok_or(StoreError::NotFound)?;
        let index = log::read(&index_path, cancel)?;
        if index.iter().filter(|r| r["planId"] == id).count() != 1 {
            return Err(GoalError::Projection("GOAL_INDEX_RECONCILIATION_REQUIRED"));
        }
        if files::identity(&index_path)?.as_ref() != Some(&index_before)
            || self.revision(id)? != snapshot.source_revision
        {
            return Err(GoalError::Changed);
        }
        if encode(&raw)?.len() > MAX_BODY - 1_048_576 - 4096 {
            return Err(GoalError::Limit);
        }
        Ok(GoalMirrorTransaction {
            _lock: lock,
            lease,
            directory: self.directory.clone(),
            plan_id: id.into(),
            execution,
            source_revision: snapshot.source_revision,
            raw,
            facts: snapshot.facts,
            index,
            index_revision: files::fingerprint(&[Some(index_before)]),
        })
    }
}
impl GoalMirrorTransaction<'_> {
    fn guard(&self, cancel: Option<&AtomicBool>) -> Result<(), GoalError> {
        self._lock.check_owned()?;
        log::check_cancel(cancel)?;
        if !self.lease.holds()? {
            return Err(StoreError::LeaseOwnershipLost.into());
        }
        let store = GoalStore {
            directory: self.directory.clone(),
        };
        if store.revision(&self.plan_id)? != self.source_revision {
            return Err(GoalError::Changed);
        }
        if files::fingerprint(&[files::identity(&self.directory.join("index.jsonl"))?])
            != self.index_revision
        {
            return Err(GoalError::Changed);
        }
        Ok(())
    }
    pub fn commit(
        self,
        fact: GoalExecutionFact<'_>,
        now: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<GoalMirrorCommit, GoalError> {
        self.commit_inner(fact, now, cancel, false)
    }
    #[cfg(feature = "test-fixtures")]
    pub fn commit_before_index_fixture(
        self,
        fact: GoalExecutionFact<'_>,
        now: &str,
    ) -> Result<GoalMirrorCommit, GoalError> {
        self.commit_inner(fact, now, None, true)
    }
    fn commit_inner(
        mut self,
        fact: GoalExecutionFact<'_>,
        now: &str,
        cancel: Option<&AtomicBool>,
        interrupt: bool,
    ) -> Result<GoalMirrorCommit, GoalError> {
        use time::{OffsetDateTime, format_description::well_known::Rfc3339};
        let at = OffsetDateTime::parse(now, &Rfc3339).map_err(|_| GoalError::Invalid)?;
        let pause = matches!(fact, GoalExecutionFact::ManagedPause(_));
        let (key, value, reason, by, identity) = match fact {
            GoalExecutionFact::ManagedPause(value) => {
                if value["kind"] != "pause"
                    || value["phase"] != "settled"
                    || !value["stopReceipt"].is_object()
                {
                    return Err(GoalError::Invalid);
                }
                (
                    "executionControl",
                    value,
                    "managed execution paused",
                    "session-control",
                    &value["expectedExecution"],
                )
            }
            GoalExecutionFact::SessionControl(value) => (
                "executionControl",
                value,
                "execution control receipt",
                "session-control",
                &value["expectedExecution"],
            ),
            GoalExecutionFact::ClaimClosure(value) => (
                "executionClaimClosure",
                value,
                "execution claim closed",
                "execution-obligation",
                &value["execution"],
            ),
        };
        if normalize_session_execution_identity(identity).as_ref() != Some(&self.execution) {
            return Err(GoalError::Projection("execution_revision_stale"));
        }
        // The owning Host validates provenance and canonical CAS. This Store
        // checks identity/shape only; an assistant string is never admitted here.
        peer_protocol::javascript_json_string(value).map_err(|_| GoalError::Limit)?;
        if !value.is_object() {
            return Err(GoalError::Invalid);
        }
        let changed = self.raw["delegationOrigin"].get(key) != Some(value)
            || pause
                && (self.raw["delegationOrigin"]["phase"] != "paused"
                    || self.raw["status"] != "paused"
                    || self.raw["runner"]["status"] != "paused");
        if changed {
            let version = self.raw["version"]
                .as_f64()
                .filter(|n| n.fract() == 0.0 && (1.0..9_007_199_254_740_991.0).contains(n))
                .unwrap_or(1.0);
            if self
                .raw
                .get("version")
                .is_some_and(|v| !v.is_null() && v.as_f64() != Some(version))
            {
                return Err(GoalError::Invalid);
            }
            let mut history = match self.raw.get("revisionHistory") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(a)) => a.clone(),
                _ => return Err(GoalError::Invalid),
            };
            if history.len() >= 4096 {
                return Err(GoalError::Limit);
            }
            history.push(
                json!({"version":version as u64+1,"reason":reason,"changedAt":now,"changedBy":by}),
            );
            self.raw["version"] = json!(version as u64 + 1);
            self.raw["revisionHistory"] = json!(history);
            self.raw["updatedAt"] = json!(now);
            self.raw["delegationOrigin"][key] = value.clone();
            // A sidecar can be the first persisted runner. Copy it only when the
            // canonical read actually admitted it, preventing updatedAt from
            // accidentally hiding that runner; keep the original sidecar/event log.
            if !self.raw["runner"].is_object() && self.facts["runner"].is_object() {
                let side = self
                    .directory
                    .join("runner-progress")
                    .join(format!("{}.json", self.plan_id));
                let patch = decode(
                    &files::read(&side, 4 * 1024 * 1024)?.ok_or(StoreError::StreamStateInvalid)?,
                    4 * 1024 * 1024,
                )?;
                if !patch["runner"].is_object()
                    || patch["runner"]["updatedAt"]
                        .as_str()
                        .is_none_or(|s| OffsetDateTime::parse(s, &Rfc3339).is_err())
                {
                    return Err(GoalError::Projection("GOAL_RUNNER_PROGRESS_UNSUPPORTED"));
                }
                self.raw["runner"] = patch["runner"].clone();
                self.raw["status"] = self.facts["status"].clone();
            }
            if pause {
                self.raw["delegationOrigin"]["phase"] = json!("paused");
                self.raw["status"] = json!("paused");
                if !self.raw["runner"].is_object() {
                    self.raw["runner"] = json!({})
                }
                self.raw["runner"]["status"] = json!("paused");
                self.raw["runner"]["updatedAt"] = json!(now);
                self.facts["status"] = json!("paused");
            }
        }
        let original_index = self.index.clone();
        for row in &mut self.index {
            if row["planId"] == self.plan_id {
                row["version"] = self.raw["version"].clone();
                row["updatedAt"] = self.raw["updatedAt"].clone();
                row["status"] = self.facts["status"].clone();
                row["percent"] = self.facts["progress"]["percent"].clone();
            }
        }
        if !changed && self.index == original_index {
            self.guard(cancel)?;
            self._lock.release()?;
            return Ok(GoalMirrorCommit {
                source_revision: self.source_revision,
                changed: false,
            });
        }
        let body = encode(&self.raw)?;
        let index = log::encode(&self.index)?;
        let event = json!({"reason":"persist","planId":self.plan_id,"conversationId":self.facts["conversationId"],"changeKind":"persist","revision":format!("{}-{}",at.unix_timestamp_nanos()/1_000_000,uuid::Uuid::new_v4()),"writerPid":std::process::id(),"changedAt":now});
        let event = log::encode(&[event])?;
        // Validate the existing append tail before modifying any source.
        let changes = self.directory.join(".changes.jsonl");
        let old_events = log::read(&changes, cancel)?;
        if old_events.len() >= 4096 {
            return Err(GoalError::Limit);
        }
        self.guard(cancel)?;
        if changed {
            log::replace(
                &self.directory.join(format!("{}.json", self.plan_id)),
                &body,
                cancel,
            )?;
        }
        if interrupt {
            return Err(GoalError::Store(StoreError::CommitUncertain));
        }
        // From here the body may already be durable. Any error is uncertain and
        // retried from the same canonical fact; it never duplicates a revision.
        let finish = (|| -> Result<(), GoalError> {
            self._lock.check_owned()?;
            if !self.lease.holds()? {
                return Err(StoreError::LeaseOwnershipLost.into());
            }
            let current =
                files::fingerprint(&[files::identity(&self.directory.join("index.jsonl"))?]);
            if current != self.index_revision {
                return Err(GoalError::Changed);
            }
            log::replace(&self.directory.join("index.jsonl"), &index, cancel)?;
            log::append(&changes, &event, cancel)?;
            Ok(())
        })();
        if finish.is_err() {
            return Err(StoreError::CommitUncertain.into());
        }
        let source_revision = GoalStore {
            directory: self.directory.clone(),
        }
        .revision(&self.plan_id)?;
        if self._lock.release().is_err() {
            return Err(StoreError::CommitUncertain.into());
        }
        Ok(GoalMirrorCommit {
            source_revision,
            changed,
        })
    }
}
