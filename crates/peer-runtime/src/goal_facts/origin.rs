use super::{date, optional, raw_text};
use serde_json::{Value, json};
fn model(v: &Value) -> Result<Option<Value>, &'static str> {
    if !v.is_object() {
        return Ok(None);
    }
    let mut out = json!({});
    for k in ["providerId", "modelId", "modelProviderId", "family"] {
        let Some(s) = optional(&v[k])? else {
            return Ok(None);
        };
        out[k] = json!(s)
    }
    if let Some(s) = optional(&v["reasoningEffort"])? {
        out["reasoningEffort"] = json!(s)
    }
    if v["fastMode"].is_boolean() {
        out["fastMode"] = v["fastMode"].clone()
    }
    Ok(Some(out))
}
fn models(v: &Value) -> Result<Option<Value>, &'static str> {
    if !v.is_object() {
        return Ok(None);
    }
    let (Some(worker), Some(explorer), Some(mut verifier), Some(resolved)) = (
        model(&v["worker"])?,
        model(&v["explorer"])?,
        model(&v["verifier"])?,
        optional(&v["resolvedAt"])?,
    ) else {
        return Ok(None);
    };
    verifier["sameFamilyAsWorker"] = json!(v["verifier"]["sameFamilyAsWorker"] == true);
    let mut source = json!({});
    if let Some(m) = v["source"].as_object() {
        for (k, item) in m {
            if [
                "this_request",
                "task",
                "objective",
                "project",
                "global",
                "auto",
            ]
            .contains(&item.as_str().unwrap_or(""))
            {
                source[k] = item.clone()
            }
        }
    }
    let mut out = json!({"worker":worker,"explorer":explorer,"verifier":verifier,"source":source,"resolvedAt":resolved});
    if let Some(value) = model(&v["visualVerifier"])? {
        out["visualVerifier"] = value
    }
    if let Some(s) = optional(&v["autoReason"])? {
        out["autoReason"] = json!(s)
    }
    Ok(Some(out))
}
pub(super) fn normalize(v: &Value) -> Result<Option<Value>, &'static str> {
    if !v.is_object() {
        return Ok(None);
    }
    let (Some(anchor), Some(input), Some(models)) = (
        optional(&v["anchorMessageId"])?,
        optional(&v["inputId"])?,
        models(&v["modelSelection"])?,
    ) else {
        return Ok(None);
    };
    let depth = v["depth"]
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n >= 0.0)
        .unwrap_or(1.0);
    let mut out = json!({"anchorMessageId":anchor,"inputId":input,"surface":v["surface"].as_str().filter(|s|["desktop","quick_chat","tui","remote"].contains(s)).unwrap_or("desktop"),"memorySnapshotId":optional(&v["memorySnapshotId"])?,"modelSelection":models,"depth":depth});
    for k in [
        "workspaceId",
        "sessionId",
        "workId",
        "parentSessionId",
        "objectiveId",
        "objectiveActionId",
        "idempotencyKey",
        "parentConversationId",
        "supersededBy",
        "lastResumeAnchorMessageId",
        "agentWaitMessageId",
        "agentResumePending",
        "executionGeneration",
    ] {
        if let Some(s) = optional(&v[k])? {
            out[k] = json!(s)
        }
    }
    let admission = &v["capabilityAdmission"];
    if admission.is_object()
        && admission["required"]
            .as_array()
            .is_some_and(|a| a.iter().all(|s| raw_text(s).is_some()))
        && admission["inventoryKnown"].is_boolean()
        && admission["requirementsDeclared"].is_boolean()
        && (admission.get("inventoryHash").is_some_and(Value::is_null)
            || raw_text(&admission["inventoryHash"]).is_some())
        && raw_text(&admission["checkedAt"]).and_then(date).is_some()
    {
        let mut required = Vec::new();
        for v in admission["required"].as_array().unwrap() {
            let s = peer_protocol::javascript_trim(v.as_str().unwrap());
            if !required.contains(&s) {
                required.push(s)
            }
        }
        out["capabilityAdmission"] = json!({"required":required,"inventoryHash":admission["inventoryHash"].as_str().map(peer_protocol::javascript_trim),"inventoryKnown":admission["inventoryKnown"],"requirementsDeclared":admission["requirementsDeclared"],"checkedAt":peer_protocol::javascript_trim(admission["checkedAt"].as_str().unwrap())});
    }
    if v["readOnly"].is_boolean() {
        out["readOnly"] = v["readOnly"].clone()
    }
    if v["verifying"] == true {
        out["verifying"] = json!(true)
    }
    for (field, phases) in [
        (
            "cancellation",
            &["stopping", "awaiting_outcome", "completed"][..],
        ),
        (
            "takeover",
            &["stopping", "completed", "superseded", "rejected"][..],
        ),
    ] {
        if v[field]["operationId"].is_string()
            && phases.contains(&v[field]["phase"].as_str().unwrap_or(""))
        {
            out[field] = v[field].clone()
        }
    }
    let c = &v["executionControl"];
    if c["operationId"].is_string()
        && c.get("sessionId") == v.get("sessionId")
        && c["planId"].is_string()
        && c["revision"]
            .as_f64()
            .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
        && ["recorded", "draining", "reconciling", "settled"]
            .contains(&c["phase"].as_str().unwrap_or(""))
    {
        out["executionControl"] = c.clone()
    }
    let b = &v["coordinationBinding"];
    if valid_closure(&v["executionClaimClosure"], v) {
        out["executionClaimClosure"] = v["executionClaimClosure"].clone();
    }
    if b["workId"].is_string()
        && b["goalRevision"]
            .as_f64()
            .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
        && b["executionEpoch"].is_string()
    {
        out["coordinationBinding"] = b.clone()
    }
    for (field, allowed) in [
        (
            "phase",
            &[
                "running",
                "queued",
                "awaiting_approval",
                "paused",
                "superseded",
            ][..],
        ),
        (
            "pausedFromPhase",
            &["running", "queued", "awaiting_approval"][..],
        ),
        (
            "pausedRunnerIntent",
            &["execute", "explore", "verify", "synthesize", "block"][..],
        ),
        ("priority", &["high", "normal", "low"][..]),
        ("isolation", &["auto", "none", "worktree"][..]),
        ("isolationBlock", &["disk_space", "isolation_failed"][..]),
    ] {
        if allowed.contains(&v[field].as_str().unwrap_or("")) {
            out[field] = v[field].clone()
        }
    }
    for field in [
        "isolationRetainedAt",
        "handoffAuthorizedAt",
        "handoffDeferredAt",
        "supersededAt",
    ] {
        if let Some(s) = raw_text(&v[field])
            && date(s).is_some()
        {
            out[field] = json!(peer_protocol::javascript_trim(s))
        }
    }
    if v["retainedForRecovery"] == true {
        out["retainedForRecovery"] = json!(true)
    }
    if let Some(a) = v["dependsOn"].as_array() {
        let values: Vec<_> = a
            .iter()
            .filter_map(raw_text)
            .map(peer_protocol::javascript_trim)
            .take(8)
            .collect();
        if !values.is_empty() {
            out["dependsOn"] = json!(values)
        }
    }
    Ok(Some(out))
}
fn valid_closure(c: &Value, origin: &Value) -> bool {
    let Some(execution) = peer_protocol::normalize_session_execution_identity(&c["execution"])
    else {
        return false;
    };
    if Some(execution.session_id.as_str()) != origin["sessionId"].as_str()
        || !["closureId", "claimId", "resourceRef", "authorityRef", "at"]
            .into_iter()
            .all(|k| c[k].as_str().is_some_and(|s| !s.is_empty()))
        || c["claimRevision"]
            .as_f64()
            .is_none_or(|n| n.fract() != 0.0 || !(1.0..=9_007_199_254_740_991.0).contains(&n))
        || !matches!(
            c["proof"].as_str(),
            Some("verified_dead" | "legacy_user_confirmed")
        )
        || c["scope"] != "managed_execution"
        || !c["unknownCalls"]
            .as_array()
            .is_some_and(|a| a.iter().all(|s| s.as_str().is_some_and(|s| !s.is_empty())))
    {
        return false;
    }
    c.get("resolution").is_none_or(|r| {
        r.is_object()
            && ["resolutionId", "evidenceDigest"]
                .into_iter()
                .all(|k| r[k].as_str().is_some_and(|s| !s.is_empty()))
            && matches!(r["tier"].as_str(), Some("user_confirmed" | "bot_verified"))
            && matches!(
                r["verdict"].as_str(),
                Some("no_effect_observed" | "effect_observed")
            )
            && r.get("policyRef").is_none_or(Value::is_string)
            && (r["tier"] != "bot_verified"
                || r["policyRef"].as_str().is_some_and(|s| !s.is_empty()))
    })
}
