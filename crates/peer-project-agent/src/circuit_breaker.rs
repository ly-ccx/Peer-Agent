//! Persistent per-workspace & per-provider circuit breaker (`circuit-breaker.json`).
//!
//! Matches `packages/runtime-node/src/project-agent/circuit-breaker.mjs` schema at
//! `<data_home>/project-runtime/<workspace_id>/circuit-breaker.json`:
//! 5 consecutive failures -> 10m cooldown -> half-open trial on expiry or manual user turn.

use crate::{ProjectError, atomic_write, format_iso, is_valid_workspace_id, parse_iso_ms};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use time::OffsetDateTime;

pub const CIRCUIT_FAILURE_LIMIT: u32 = 5;
pub const CIRCUIT_COOLDOWN_MS: i64 = 10 * 60 * 1000;
const MAX_BREAKER_BYTES: u64 = 256 * 1024;
const LEGACY_SCOPE: &str = "__legacy__";

fn default_version() -> u32 {
    1
}

fn default_status() -> String {
    "closed".to_owned()
}

fn ms_to_iso(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(format_iso)
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}

fn clip_reason(reason: &str) -> String {
    reason.chars().take(500).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitScopeState {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub failures: u32,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub open_until: Option<String>,
    #[serde(default)]
    pub last_turn_id: Option<String>,
    #[serde(default)]
    pub scope_key: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub retry: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for CircuitScopeState {
    fn default() -> Self {
        Self {
            version: 1,
            failures: 0,
            status: "closed".to_owned(),
            open_until: None,
            last_turn_id: None,
            scope_key: None,
            reason: None,
            retry: None,
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitBreakerState {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub failures: u32,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub open_until: Option<String>,
    #[serde(default)]
    pub last_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub provider_scopes: BTreeMap<String, CircuitScopeState>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for CircuitBreakerState {
    fn default() -> Self {
        Self {
            version: 1,
            failures: 0,
            status: "closed".to_owned(),
            open_until: None,
            last_turn_id: None,
            scope_key: None,
            reason: None,
            retry: None,
            provider_scopes: BTreeMap::new(),
            extra: Map::new(),
        }
    }
}

impl CircuitBreakerState {
    fn top_scope(&self) -> CircuitScopeState {
        CircuitScopeState {
            version: self.version,
            failures: self.failures,
            status: self.status.clone(),
            open_until: self.open_until.clone(),
            last_turn_id: self.last_turn_id.clone(),
            scope_key: self.scope_key.clone(),
            reason: self.reason.clone(),
            retry: self.retry.clone(),
            extra: self.extra.clone(),
        }
    }

    fn apply_top_scope(&mut self, scope: &CircuitScopeState) {
        self.version = 1;
        self.failures = scope.failures;
        self.status = scope.status.clone();
        self.open_until = scope.open_until.clone();
        self.last_turn_id = scope.last_turn_id.clone();
        self.scope_key = scope.scope_key.clone();
        self.reason = scope.reason.clone();
        self.retry = scope.retry.clone();
    }

    fn effective_scope(&self, scope_key: Option<&str>) -> CircuitScopeState {
        let Some(key) = scope_key.filter(|s| !s.is_empty()) else {
            return self.top_scope();
        };
        if let Some(found) = self.provider_scopes.get(key) {
            return found.clone();
        }
        // Inherit legacy top-level state only when no scoped states existed yet (TS parity).
        if self.provider_scopes.is_empty() && self.scope_key.is_none() {
            return self.top_scope();
        }
        CircuitScopeState {
            scope_key: Some(key.to_owned()),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CircuitAdmit {
    Admitted { trial: bool },
    Blocked { open_until: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureOutcome {
    pub tripped: bool,
    pub open_until: Option<String>,
    pub failures: u32,
}

/// Legacy in-memory circuit breaker retained for backward API compatibility.
#[derive(Debug, Clone, Default)]
pub struct CircuitBreaker {
    consecutive_failures: u32,
    open_until_ms: Option<i64>,
    last_reason: Option<String>,
}

impl CircuitBreaker {
    pub fn is_open(&self, now_ms: i64) -> bool {
        self.open_until_ms.is_some_and(|until| now_ms < until)
    }

    pub fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.open_until_ms = None;
        self.last_reason = None;
    }

    pub fn record_failure(&mut self, reason: &str, now_ms: i64) -> bool {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        self.last_reason = Some(reason.to_owned());
        if self.consecutive_failures >= CIRCUIT_FAILURE_LIMIT {
            self.open_until_ms = Some(now_ms + CIRCUIT_COOLDOWN_MS);
            true
        } else {
            false
        }
    }

    pub fn reset_manual(&mut self) {
        self.record_success();
    }
}

pub struct CircuitBreakerStore {
    runtime_dir: PathBuf,
    trials: Mutex<HashSet<String>>,
}

impl CircuitBreakerStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            runtime_dir: data_home.as_ref().join("project-runtime"),
            trials: Mutex::new(HashSet::new()),
        }
    }

    fn path_for(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self
            .runtime_dir
            .join(workspace_id)
            .join("circuit-breaker.json"))
    }

    fn trial_key(workspace_id: &str, scope_key: Option<&str>) -> String {
        let scope = scope_key.filter(|s| !s.is_empty()).unwrap_or(LEGACY_SCOPE);
        format!("{workspace_id}\0{scope}")
    }

    fn is_valid_scope(scope: &CircuitScopeState) -> bool {
        matches!(scope.status.as_str(), "closed" | "open" | "half_open")
            && (scope.status == "closed"
                || scope.open_until.as_deref().and_then(parse_iso_ms).is_some())
    }

    pub fn read(&self, workspace_id: &str) -> CircuitBreakerState {
        let Ok(path) = self.path_for(workspace_id) else {
            return CircuitBreakerState::default();
        };
        let Ok(meta) = fs::metadata(&path) else {
            return CircuitBreakerState::default();
        };
        if !meta.is_file() || meta.len() > MAX_BREAKER_BYTES {
            return CircuitBreakerState::default();
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            return CircuitBreakerState::default();
        };
        let Ok(parsed) = serde_json::from_str::<CircuitBreakerState>(&raw) else {
            return CircuitBreakerState::default();
        };
        if parsed.version != 1
            || !Self::is_valid_scope(&parsed.top_scope())
            || parsed
                .provider_scopes
                .values()
                .any(|s| !Self::is_valid_scope(s))
        {
            return CircuitBreakerState::default();
        }
        parsed
    }

    fn write_state(
        &self,
        workspace_id: &str,
        state: &CircuitBreakerState,
    ) -> Result<(), ProjectError> {
        let path = self.path_for(workspace_id)?;
        let mut encoded = serde_json::to_string(state)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        encoded.push('\n');
        atomic_write(&path, encoded.as_bytes())
    }

    fn save_scope(
        &self,
        workspace_id: &str,
        scope_key: Option<&str>,
        mut state: CircuitBreakerState,
        scope: CircuitScopeState,
    ) -> Result<(), ProjectError> {
        if let Some(key) = scope_key.filter(|s| !s.is_empty()) {
            let mut updated = scope;
            updated.scope_key = Some(key.to_owned());
            state.apply_top_scope(&updated);
            state.provider_scopes.insert(key.to_owned(), updated);
        } else {
            state.apply_top_scope(&scope);
        }
        self.write_state(workspace_id, &state)
    }

    pub fn admit(
        &self,
        workspace_id: &str,
        manual: bool,
        scope_key: Option<&str>,
        now_ms: i64,
    ) -> Result<CircuitAdmit, ProjectError> {
        let state = self.read(workspace_id);
        let mut scope = state.effective_scope(scope_key);
        if scope.status == "closed" {
            return Ok(CircuitAdmit::Admitted { trial: false });
        }
        let key = Self::trial_key(workspace_id, scope_key);
        if let Ok(trials) = self.trials.lock()
            && trials.contains(&key)
        {
            return Ok(CircuitAdmit::Blocked {
                open_until: scope.open_until,
            });
        }
        let cooldown_expired = scope
            .open_until
            .as_deref()
            .and_then(parse_iso_ms)
            .is_some_and(|until| now_ms >= until);
        if !manual && !cooldown_expired {
            return Ok(CircuitAdmit::Blocked {
                open_until: scope.open_until,
            });
        }
        if let Ok(mut trials) = self.trials.lock() {
            trials.insert(key);
        }
        scope.status = "half_open".to_owned();
        if scope.open_until.is_none() {
            scope.open_until = Some(ms_to_iso(now_ms + CIRCUIT_COOLDOWN_MS));
        }
        self.save_scope(workspace_id, scope_key, state, scope)?;
        Ok(CircuitAdmit::Admitted { trial: true })
    }

    pub fn record_failure(
        &self,
        workspace_id: &str,
        turn_id: &str,
        reason: &str,
        scope_key: Option<&str>,
        retry: Option<Value>,
        now_ms: i64,
    ) -> Result<FailureOutcome, ProjectError> {
        let state = self.read(workspace_id);
        let mut scope = state.effective_scope(scope_key);
        if !turn_id.is_empty() && scope.last_turn_id.as_deref() == Some(turn_id) {
            return Ok(FailureOutcome {
                tripped: scope.status == "open",
                open_until: scope.open_until,
                failures: scope.failures,
            });
        }
        let was_half_open = scope.status == "half_open";
        scope.failures = scope.failures.saturating_add(1);
        let opened = was_half_open || scope.failures >= CIRCUIT_FAILURE_LIMIT;
        scope.status = if opened { "open" } else { "closed" }.to_owned();
        scope.open_until = if opened {
            Some(ms_to_iso(now_ms + CIRCUIT_COOLDOWN_MS))
        } else {
            None
        };
        scope.last_turn_id = (!turn_id.is_empty()).then(|| turn_id.to_owned());
        scope.reason = Some(clip_reason(reason));
        scope.retry = retry;

        if let Ok(mut trials) = self.trials.lock() {
            trials.remove(&Self::trial_key(workspace_id, scope_key));
        }
        let out = FailureOutcome {
            tripped: opened,
            open_until: scope.open_until.clone(),
            failures: scope.failures,
        };
        self.save_scope(workspace_id, scope_key, state, scope)?;
        Ok(out)
    }

    pub fn record_success(
        &self,
        workspace_id: &str,
        scope_key: Option<&str>,
    ) -> Result<(), ProjectError> {
        if let Ok(mut trials) = self.trials.lock() {
            trials.remove(&Self::trial_key(workspace_id, scope_key));
        }
        let state = self.read(workspace_id);
        let existing = state.effective_scope(scope_key);
        if existing.status == "closed" && existing.failures == 0 && existing.last_turn_id.is_none()
        {
            return Ok(());
        }
        let cleared = CircuitScopeState {
            version: 1,
            failures: 0,
            status: "closed".to_owned(),
            open_until: None,
            last_turn_id: None,
            scope_key: scope_key.filter(|s| !s.is_empty()).map(str::to_owned),
            reason: None,
            retry: None,
            extra: existing.extra,
        };
        self.save_scope(workspace_id, scope_key, state, cleared)
    }

    pub fn abandon_trial(
        &self,
        workspace_id: &str,
        scope_key: Option<&str>,
    ) -> Result<(), ProjectError> {
        if let Ok(mut trials) = self.trials.lock() {
            trials.remove(&Self::trial_key(workspace_id, scope_key));
        }
        let state = self.read(workspace_id);
        let mut scope = state.effective_scope(scope_key);
        if scope.status != "half_open" {
            return Ok(());
        }
        scope.status = "open".to_owned();
        if scope.open_until.is_none() {
            scope.open_until = Some(ms_to_iso(
                crate::parse_iso_ms(&crate::now_iso()).unwrap_or(0) + CIRCUIT_COOLDOWN_MS,
            ));
        }
        self.save_scope(workspace_id, scope_key, state, scope)
    }

    pub fn reset_manual(&self, workspace_id: &str) -> Result<(), ProjectError> {
        if let Ok(mut trials) = self.trials.lock() {
            let prefix = format!("{workspace_id}\0");
            trials.retain(|k| !k.starts_with(&prefix));
        }
        let mut state = self.read(workspace_id);
        state.failures = 0;
        state.status = "closed".to_owned();
        state.open_until = None;
        state.last_turn_id = None;
        state.reason = None;
        state.retry = None;
        for scope in state.provider_scopes.values_mut() {
            scope.failures = 0;
            scope.status = "closed".to_owned();
            scope.open_until = None;
            scope.last_turn_id = None;
            scope.reason = None;
            scope.retry = None;
        }
        self.write_state(workspace_id, &state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn persistent_breaker_trips_at_five_dedups_turn_and_isolates_provider_scopes() {
        let dir = tempdir().unwrap();
        let store = CircuitBreakerStore::new(dir.path());
        let ws = "ws-cb-1";
        let base_ms = 1_700_000_000_000i64;

        // First 4 failures leave circuit closed
        for i in 1..=4 {
            let res = store
                .record_failure(
                    ws,
                    &format!("t-{i}"),
                    "upstream_error",
                    Some("provider:openai"),
                    None,
                    base_ms,
                )
                .unwrap();
            assert!(!res.tripped);
            assert_eq!(res.failures, i);
        }

        // Duplicate turnId is ignored
        let dup = store
            .record_failure(
                ws,
                "t-4",
                "upstream_error",
                Some("provider:openai"),
                None,
                base_ms,
            )
            .unwrap();
        assert_eq!(dup.failures, 4);
        assert!(!dup.tripped);

        // 5th failure trips circuit open
        let trip = store
            .record_failure(
                ws,
                "t-5",
                "upstream_error",
                Some("provider:openai"),
                None,
                base_ms,
            )
            .unwrap();
        assert!(trip.tripped);
        assert_eq!(trip.failures, 5);
        assert!(trip.open_until.is_some());

        // Fresh store reading from disk sees open circuit for openai, closed for anthropic
        let reloaded = CircuitBreakerStore::new(dir.path());
        assert!(matches!(
            reloaded
                .admit(ws, false, Some("provider:openai"), base_ms + 1_000)
                .unwrap(),
            CircuitAdmit::Blocked { .. }
        ));
        assert_eq!(
            reloaded
                .admit(ws, false, Some("provider:anthropic"), base_ms + 1_000)
                .unwrap(),
            CircuitAdmit::Admitted { trial: false }
        );

        // Once cooldown expires, admit transitions to half_open trial; concurrent call blocked;
        // abandon_trial reverts to open.
        assert_eq!(
            reloaded
                .admit(
                    ws,
                    false,
                    Some("provider:openai"),
                    base_ms + CIRCUIT_COOLDOWN_MS
                )
                .unwrap(),
            CircuitAdmit::Admitted { trial: true }
        );
        assert!(matches!(
            reloaded
                .admit(
                    ws,
                    false,
                    Some("provider:openai"),
                    base_ms + CIRCUIT_COOLDOWN_MS + 10
                )
                .unwrap(),
            CircuitAdmit::Blocked { .. }
        ));
        reloaded.abandon_trial(ws, Some("provider:openai")).unwrap();
        assert_eq!(reloaded.read(ws).status, "open");

        // Manual admit -> success resets state cleanly
        assert_eq!(
            reloaded
                .admit(ws, true, Some("provider:openai"), base_ms + 2_000)
                .unwrap(),
            CircuitAdmit::Admitted { trial: true }
        );
        reloaded
            .record_success(ws, Some("provider:openai"))
            .unwrap();
        let after = reloaded.read(ws);
        assert_eq!(after.status, "closed");
        assert_eq!(after.failures, 0);
    }

    #[test]
    fn preserves_ts_compatible_extra_fields_on_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir
            .path()
            .join("project-runtime/ws-ts/circuit-breaker.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::to_string(&json!({
                "version": 1,
                "failures": 2,
                "status": "closed",
                "openUntil": null,
                "lastTurnId": "turn-prev",
                "tsCustomField": "keep-me"
            }))
            .unwrap(),
        )
        .unwrap();

        let store = CircuitBreakerStore::new(dir.path());
        store
            .record_failure("ws-ts", "turn-next", "boom", None, None, 1_700_000_000_000)
            .unwrap();
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["failures"], 3);
        assert_eq!(raw["tsCustomField"], "keep-me");
        assert_eq!(raw["version"], 1);
    }
}
