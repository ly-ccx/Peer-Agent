//! Capacity belongs to one provider request. Billing totals never enter here.
use peer_protocol::UsageAmounts;
use serde_json::{Value, json};
use std::sync::LazyLock;
const SAFE: u64 = 9_007_199_254_740_991;
static CONFIG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/context-accounting-config.json"
    ))
    .expect("context accounting contract")
});

pub struct ContextCapacity {
    conversation: String,
    model: String,
    content_revision: u64,
    window: Option<u64>,
    reserve: u64,
    counter: bool,
    degraded: bool,
    revision: u64,
    epoch: u64,
    compaction_revision: u64,
    phase: &'static str,
    latest: Option<String>,
    observed: Option<Value>,
    counted: Option<Value>,
    verification: Option<Value>,
    overflow: Option<Value>,
}
impl ContextCapacity {
    pub fn new(
        conversation: &str,
        model_key: &str,
        window: Option<u64>,
        reserve: u64,
        counter: bool,
    ) -> Self {
        Self {
            conversation: conversation.into(),
            model: model_key.into(),
            content_revision: 0,
            window: window.filter(|n| *n > 0 && *n <= SAFE),
            reserve: reserve.min(SAFE),
            counter,
            degraded: false,
            revision: 0,
            epoch: 0,
            compaction_revision: 0,
            phase: "restored",
            latest: None,
            observed: None,
            counted: None,
            verification: None,
            overflow: None,
        }
    }
    pub fn should_count(&self) -> bool {
        self.counter && !self.degraded
    }
    /// Only a request observation from a matching sidecar may seed occupancy.
    /// Counts are always rebuilt, and billing is never consulted.
    pub fn restore(
        &mut self,
        snapshot: Option<&Value>,
        epoch: Option<u64>,
        content_revision: u64,
    ) -> Result<(), &'static str> {
        if content_revision > SAFE || epoch.is_some_and(|n| n > SAFE) {
            return Err("context_revision_limit");
        }
        self.content_revision = content_revision;
        self.epoch = epoch.unwrap_or(0);
        self.latest = None;
        self.counted = None;
        self.observed = None;
        self.verification = None;
        self.overflow = None;
        self.degraded = false;
        self.revision = 0;
        self.compaction_revision = 0;
        self.phase = "restored";
        let Some(v) = snapshot.filter(|v| {
            v["version"].as_f64() == Some(1.0)
                && v["projectorVersion"].as_f64() == Some(3.0)
                && v["conversationId"] == self.conversation
                && v["modelKey"] == self.model
                && epoch.is_none_or(|epoch| v["compactionEpoch"].as_f64() == Some(epoch as f64))
        }) else {
            return Ok(());
        };
        let safe = |v: &Value| {
            v.as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= SAFE as f64)
                .map(|n| n as u64)
        };
        if epoch.is_none() {
            self.epoch = safe(&v["compactionEpoch"]).unwrap_or(0);
        }
        self.revision = safe(&v["revision"]).unwrap_or(0);
        self.degraded = v["counterStatus"] == "degraded";
        let observed = &v["lastObserved"];
        if observed["source"] == "provider_usage"
            && observed["supersededByCompactionRevision"].is_null()
            && safe(&observed["compactionEpoch"]) == Some(self.epoch)
            && safe(&observed["inputTokens"]).is_some_and(|n| n > 0)
            && observed["requestFingerprint"]
                .as_str()
                .is_some_and(|s| !peer_protocol::javascript_trim(s).is_empty() && s.len() <= 1024)
            && safe(&observed["observedAt"]).is_some()
        {
            let mut normalized = observed.clone();
            normalized["compactionEpoch"] = json!(self.epoch);
            normalized["inputTokens"] = json!(safe(&observed["inputTokens"]).unwrap());
            normalized["observedAt"] = json!(safe(&observed["observedAt"]).unwrap());
            self.observed = Some(normalized);
        }
        self.phase = "restored";
        Ok(())
    }
    pub fn built(
        &mut self,
        fingerprint: &str,
        content_revision: u64,
        count: Result<Option<crate::model::ProviderTokenCount>, ()>,
        at: i64,
    ) -> Result<(), &'static str> {
        if content_revision > SAFE || fingerprint.is_empty() || fingerprint.len() > 1024 {
            return Err("context_request_invalid");
        }
        self.content_revision = content_revision;
        self.latest = Some(fingerprint.into());
        self.counted = None;
        if self.should_count() {
            match count {
                Ok(Some(count))
                    if count.request_fingerprint == fingerprint
                        && count.input_tokens > 0
                        && count.input_tokens <= SAFE =>
                {
                    self.counted = Some(
                        json!({"inputTokens":count.input_tokens,"requestFingerprint":fingerprint,"compactionEpoch":self.epoch,"source":"provider_count_api","countedAt":at}),
                    );
                }
                Ok(None) => {}
                Ok(Some(count))
                    if count.input_tokens == 0 && count.request_fingerprint == fingerprint => {}
                _ => self.degraded = true,
            }
        }
        Ok(())
    }
    pub fn observe(
        &mut self,
        usage: Option<&UsageAmounts>,
        fingerprint: &str,
        at: i64,
    ) -> Result<(), &'static str> {
        let Some(usage) = usage else { return Ok(()) };
        let input = usage
            .input_tokens
            .checked_add(usage.cache_read_tokens)
            .filter(|n| *n <= SAFE)
            .ok_or("context_usage_invalid")?;
        if input == 0 {
            return Ok(());
        }
        self.observed = Some(
            json!({"inputTokens":input,"requestFingerprint":fingerprint,"compactionEpoch":self.epoch,"source":"provider_usage","observedAt":at}),
        );
        if let Some(count) = &self.counted
            && count["requestFingerprint"] == fingerprint
        {
            let counted = count["inputTokens"]
                .as_u64()
                .ok_or("context_usage_invalid")?;
            let absolute = counted.abs_diff(input);
            let relative = absolute as f64 / input.max(1) as f64;
            let tolerance = CONFIG["driftToleranceRatio"].as_f64().unwrap();
            let drift = relative > tolerance;
            self.verification = Some(
                json!({"requestFingerprint":fingerprint,"countedInputTokens":counted,"observedInputTokens":input,"absoluteDelta":absolute,"relativeDelta":if absolute==0 {json!(0)}else{json!(relative)},"tolerance":tolerance,"status":if drift{"drift"}else{"verified"},"verifiedAt":at}),
            );
            if drift {
                self.degraded = true;
                self.counted = None;
            }
        }
        Ok(())
    }
    pub fn compacted(&mut self) -> Result<(), &'static str> {
        let epoch = self
            .epoch
            .checked_add(1)
            .filter(|n| *n <= SAFE)
            .ok_or("context_revision_limit")?;
        let revision = self
            .compaction_revision
            .checked_add(1)
            .filter(|n| *n <= SAFE)
            .ok_or("context_revision_limit")?;
        self.epoch = epoch;
        self.compaction_revision = revision;
        self.counted = None;
        self.overflow = None;
        if let Some(observed) = &mut self.observed
            && observed["supersededByCompactionRevision"].is_null()
        {
            observed["supersededByCompactionRevision"] = json!(revision);
        }
        Ok(())
    }
    pub fn overflow(&mut self, status: u16) {
        self.overflow = Some(
            json!({"status":status,"message":"Provider rejected the current request for context length."}),
        );
    }
    pub fn content_changed(&mut self, revision: u64) -> Result<(), &'static str> {
        if revision > SAFE {
            return Err("context_revision_limit");
        }
        self.content_revision = revision;
        self.latest = None;
        Ok(())
    }
    pub fn complete(&mut self) {
        self.latest = None;
    }
    pub fn publish(&mut self, phase: &'static str, at: i64) -> Result<Value, &'static str> {
        if !matches!(
            phase,
            "request_preflight"
                | "stream_preview"
                | "tool_result"
                | "post_compaction"
                | "turn_complete"
                | "restored"
                | "model_changed"
        ) {
            return Err("context_phase_invalid");
        }
        self.revision = self
            .revision
            .checked_add(1)
            .filter(|n| *n <= SAFE)
            .ok_or("context_revision_limit")?;
        self.phase = phase;
        Ok(self.snapshot(at))
    }
    pub fn snapshot(&self, at: i64) -> Value {
        let observed = self.observed.as_ref().filter(|v| {
            v["compactionEpoch"] == self.epoch && v["supersededByCompactionRevision"].is_null()
        });
        let counted = self
            .counted
            .as_ref()
            .filter(|v| v["compactionEpoch"] == self.epoch);
        let matches = |v: Option<&Value>| {
            v.is_some_and(|v| {
                self.latest
                    .as_deref()
                    .is_some_and(|fp| v["requestFingerprint"] == fp)
            })
        };
        let observed_matches = matches(observed);
        let counted_matches = matches(counted);
        let supersedes = observed
            .zip(counted)
            .is_some_and(|(a, b)| a["requestFingerprint"] == b["requestFingerprint"]);
        let authority = if observed_matches {
            observed
        } else if counted_matches {
            counted
        } else if supersedes {
            observed
        } else {
            counted.or(observed)
        };
        let tokens = authority.and_then(|v| v["inputTokens"].as_u64());
        let input_budget = self.window.map(|w| w.saturating_sub(self.reserve).max(1));
        let threshold = input_budget
            .map(|w| (w as f64 * CONFIG["triggerRatio"].as_f64().unwrap()).floor() as u64);
        let percent = self
            .window
            .zip(tokens)
            .map(|(w, n)| ((n as f64 / w as f64 * 100.0).round() as u64).min(100));
        let mut value = json!({"version":1,"conversationId":self.conversation,"contentRevision":self.content_revision,"modelKey":self.model,"revision":self.revision,"phase":self.phase,"compactionEpoch":self.epoch,"contextWindow":self.window,"inputBudget":input_budget,"compactionThresholdTokens":threshold,"authoritativeInputTokens":tokens,"percent":percent,"pressureSource":authority.map(|v|v["source"].clone()).unwrap_or(json!("unknown")),"pendingUncountedChanges":tokens.is_none() || (!observed_matches && !counted_matches),"pendingContentChars":0,"countCapability":{"kind":if self.counter{"provider_count_api"}else{"observed_usage_only"}},"counterStatus":if self.degraded{"degraded"}else{"active"},"updatedAt":at});
        for (key, data) in [
            ("lastObserved", self.observed.as_ref()),
            ("nextCounted", counted),
            ("verification", self.verification.as_ref()),
            ("lastOverflow", self.overflow.as_ref()),
        ] {
            if let Some(data) = data {
                value[key] = data.clone();
            }
        }
        value
    }
    pub fn decision(&self) -> Option<Value> {
        let snapshot = self.snapshot(0);
        let tokens = snapshot["authoritativeInputTokens"].as_u64()?;
        let window = snapshot["inputBudget"].as_u64()?;
        let trigger = CONFIG["triggerRatio"].as_f64().unwrap();
        let hard_ratio = CONFIG["hardRatio"].as_f64().unwrap();
        let soft = (window as f64 * trigger).floor() as u64;
        let hard = (window as f64 * hard_ratio).floor() as u64;
        let (compact, force, pressure, reason) = if tokens > window {
            (true, true, "overflow", "context_overflow")
        } else if tokens >= hard {
            (true, true, "hard", "hard_limit")
        } else if tokens >= window {
            (true, false, "soft", "insufficient_summary_headroom")
        } else if tokens >= soft {
            (true, false, "soft", "soft_limit")
        } else {
            (false, false, "ok", "below_threshold")
        };
        Some(
            json!({"shouldCompact":compact,"force":force,"pressure":pressure,"reason":reason,"triggerRatio":trigger,"hardRatio":hard_ratio,"softLimit":soft,"hardLimit":hard}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_reuses_only_same_epoch_observation_and_always_rebuilds_counts() {
        let mut capacity = ContextCapacity::new("c", "provider::model", Some(1000), 0, true);
        let saved = json!({"version":1,"projectorVersion":3,"conversationId":"c","modelKey":"provider::model","revision":4,"compactionEpoch":1,"counterStatus":"active","lastObserved":{"inputTokens":20,"requestFingerprint":"actual","compactionEpoch":1,"source":"provider_usage","observedAt":1},"nextCounted":{"inputTokens":999,"requestFingerprint":"old-count"}});
        capacity.restore(Some(&saved), Some(1), 3).unwrap();
        let restored = capacity.snapshot(2);
        assert_eq!(restored["authoritativeInputTokens"], 20);
        assert_eq!(restored["pendingUncountedChanges"], true);
        assert!(restored["nextCounted"].is_null());
        capacity.restore(Some(&saved), Some(2), 4).unwrap();
        assert!(capacity.snapshot(3)["authoritativeInputTokens"].is_null());
        let mut superseded = saved.clone();
        superseded["lastObserved"]["supersededByCompactionRevision"] = json!(1);
        capacity.restore(Some(&superseded), Some(1), 3).unwrap();
        assert!(capacity.snapshot(4)["authoritativeInputTokens"].is_null());
        capacity.restore(Some(&saved), Some(1), 3).unwrap();
        capacity.restore(None, Some(1), 4).unwrap();
        assert!(capacity.snapshot(5)["lastObserved"].is_null());
    }
    static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
        serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/context-accounting-native.json"
        ))
        .unwrap()
    });
    fn count(value: &Value, fp: &str) -> Result<Option<crate::model::ProviderTokenCount>, ()> {
        if value == "error" {
            return Err(());
        }
        Ok(value
            .as_u64()
            .map(|input_tokens| crate::model::ProviderTokenCount {
                input_tokens,
                request_fingerprint: fp.into(),
                source: "provider_count_api",
            }))
    }
    #[test]
    fn authority_pending_drift_degradation_and_epoch_match_actual_ts_pipeline() {
        for case in CONTRACT["cases"].as_array().unwrap() {
            let mut state = ContextCapacity::new(
                "c",
                "provider::model",
                case["window"].as_u64(),
                case["reserve"].as_u64().unwrap_or(0),
                case["counter"] != false,
            );
            for step in case["steps"].as_array().unwrap() {
                let fp = step["fingerprint"].as_str().unwrap();
                let mut counted = usize::from(state.should_count());
                state.built(fp, 1, count(&step["count"], fp), 1000).unwrap();
                let mut decision = state.decision();
                let mut compacted = false;
                let mut active_fp = fp;
                if (step["command"] == "manual_compact"
                    || decision
                        .as_ref()
                        .is_some_and(|d| d["shouldCompact"] == true))
                    && step["compact"] == true
                {
                    state.compacted().unwrap();
                    active_fp = step["afterFingerprint"].as_str().unwrap();
                    counted += usize::from(state.should_count());
                    state
                        .built(active_fp, 1, count(&step["recount"], active_fp), 1000)
                        .unwrap();
                    decision = state.decision();
                    compacted = true;
                }
                let mut snapshots = vec![];
                let mut sent = 0;
                if step["command"] == "manual_compact" {
                    snapshots.push(
                        state
                            .publish(
                                if compacted {
                                    "post_compaction"
                                } else {
                                    "request_preflight"
                                },
                                1000,
                            )
                            .unwrap(),
                    );
                } else {
                    if compacted {
                        snapshots.push(state.publish("post_compaction", 1000).unwrap());
                    }
                    snapshots.push(state.publish("request_preflight", 1000).unwrap());
                    sent += 1;
                    let u = &step["usage"];
                    let usage = u.is_object().then(|| UsageAmounts {
                        input_tokens: u["inputTokens"].as_u64().unwrap_or(0),
                        cache_read_tokens: u["cacheReadTokens"].as_u64().unwrap_or(0),
                        ..UsageAmounts::default()
                    });
                    state.observe(usage.as_ref(), active_fp, 1000).unwrap();
                    state.complete();
                    snapshots.push(state.publish("turn_complete", 1000).unwrap());
                }
                assert_eq!(
                    json!({"snapshots":snapshots,"decision":decision,"sent":sent,"counted":counted}),
                    step["expected"],
                    "{} / {}",
                    case["name"],
                    fp
                );
            }
        }
    }
    #[test]
    fn foreign_count_is_not_capacity_and_overflow_preserves_the_observation() {
        let mut state = ContextCapacity::new("c", "provider::model", Some(100), 0, true);
        state
            .built("actual", 1, count(&json!(70), "foreign"), 1000)
            .unwrap();
        assert_eq!(state.snapshot(1000)["counterStatus"], "degraded");
        assert!(state.snapshot(1000)["authoritativeInputTokens"].is_null());
        state
            .observe(
                Some(&UsageAmounts {
                    input_tokens: 50,
                    ..UsageAmounts::default()
                }),
                "actual",
                1000,
            )
            .unwrap();
        let before = state.snapshot(1000);
        assert!(
            state
                .observe(
                    Some(&UsageAmounts {
                        input_tokens: SAFE,
                        cache_read_tokens: 1,
                        ..UsageAmounts::default()
                    }),
                    "actual",
                    1000
                )
                .is_err()
        );
        assert_eq!(state.snapshot(1000), before);
        assert!(state.built("actual", SAFE + 1, Ok(None), 1000).is_err());
        assert!(state.content_changed(SAFE + 1).is_err());
        assert_eq!(state.snapshot(1000), before);
    }
}
