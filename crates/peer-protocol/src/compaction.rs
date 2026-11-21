use serde_json::{Value, json};
use std::sync::LazyLock;
static LIMITS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/compaction-history-selection-v1.json"
    ))
    .unwrap()
});
pub const CANONICAL_HISTORY_PROJECTOR_VERSION: u64 = 3;
pub fn context_history_binding(rows: &[Value]) -> Result<Value, &'static str> {
    let error = "compaction_history_selection_invalid";
    let mut out = json!({"projectorVersion":3,"compactionBoundaryId":null,"compactionEpoch":0,"selectionVersion":0});
    let mut identities = std::collections::HashMap::new();
    let mut last = None;
    for (i, row) in rows.iter().enumerate() {
        let marker = row
            .get("_compaction")
            .filter(|v| v.is_object())
            .or_else(|| row.get("compaction").filter(|v| v.is_object()));
        if let Some(id) = row["id"].as_str().filter(|s| !s.is_empty()) {
            let allowed = marker.is_none()
                && matches!(row["role"].as_str(), Some("user" | "assistant" | "tool"))
                && !matches!(
                    row["kind"].as_str(),
                    Some("agent_message" | "agent_activity")
                );
            let entry = identities.entry(id).or_insert((i, 0usize, allowed));
            entry.1 += 1;
        }
        let Some(marker) = marker else { continue };
        let selected = marker
            .get("historySelection")
            .map(|v| normalize_compaction_history_selection(v).ok_or(error))
            .transpose()?;
        let id = row["id"]
            .as_str()
            .filter(|s| !crate::javascript_trim(s).is_empty());
        if selected.is_some()
            && (id.is_none()
                || marker["summary"]
                    .as_str()
                    .is_none_or(|s| crate::javascript_trim(s).is_empty()))
        {
            return Err(error);
        }
        out = json!({"projectorVersion":3,"compactionBoundaryId":id.map(str::to_owned).unwrap_or_else(||format!("compaction_{i}")),"compactionEpoch":selected.as_ref().map(|s|s.compaction_epoch).unwrap_or(0),"selectionVersion":if selected.is_some(){1}else{0}});
        last = selected.map(|s| (i, s));
    }
    if let Some((boundary, selection)) = last {
        let mut previous = None;
        for id in selection.retained_message_ids {
            let &(position, count, allowed) = identities.get(id.as_str()).ok_or(error)?;
            if count != 1
                || !allowed
                || position >= boundary
                || previous.is_some_and(|n| position <= n)
            {
                return Err(error);
            }
            previous = Some(position);
        }
    }
    Ok(out)
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionHistorySelection {
    pub version: u64,
    pub compaction_epoch: u64,
    pub retained_message_ids: Vec<String>,
}
pub fn normalize_compaction_history_selection(v: &Value) -> Option<CompactionHistorySelection> {
    if v.as_object()?.keys().any(|k| {
        !matches!(
            k.as_str(),
            "version" | "compactionEpoch" | "retainedMessageIds"
        )
    }) || v["version"].as_f64() != Some(1.0)
    {
        return None;
    }
    let epoch = v["compactionEpoch"].as_f64().filter(|n| {
        n.is_finite() && *n > 0.0 && n.fract() == 0.0 && *n <= 9_007_199_254_740_991.0
    })? as u64;
    let ids = v["retainedMessageIds"].as_array()?;
    if ids.len() > LIMITS["maxRetained"].as_u64()? as usize {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    let mut bytes = 0;
    for id in ids {
        let s = id.as_str()?;
        bytes += s.len();
        if s.is_empty() || s.len() > LIMITS["maxIdBytes"].as_u64()? as usize || !seen.insert(s) {
            return None;
        }
        result.push(s.to_owned());
    }
    if bytes > LIMITS["maxSelectionBytes"].as_u64()? as usize {
        return None;
    }
    Some(CompactionHistorySelection {
        version: 1,
        compaction_epoch: epoch,
        retained_message_ids: result,
    })
}
pub fn build_compaction_marker(input: &Value) -> Result<Value, &'static str> {
    let method = input["method"]
        .as_str()
        .filter(|s| matches!(*s, "llm" | "structured" | "structural" | "fallback_drop"))
        .unwrap_or("structured");
    let summary = input["summary"].as_str().unwrap_or("");
    let mut out = json!({"method":method,"summary":summary,"decisionAnchors":input["decisionAnchors"].as_array().map(|a|a.iter().filter(|v|v.as_str().is_some_and(|s|!s.is_empty())).cloned().collect::<Vec<_>>()).unwrap_or_default()});
    for k in [
        "originalMessageCount",
        "previousMessageCount",
        "deltaMessageCount",
        "beforeTokens",
        "afterTokens",
    ] {
        out[k] = json!(
            input[k]
                .as_f64()
                .filter(|n| n.is_finite() && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
                .map(|n| n.floor() as u64)
                .unwrap_or(0)
        );
    }
    for k in ["fallbackReason", "fallbackDetail"] {
        if input[k].as_str().is_some_and(|s| !s.trim().is_empty()) {
            out[k] = input[k].clone();
        }
    }
    for key in ["budgetSnapshot", "canonicalCheckpoint"] {
        if input[key].is_object() {
            out[key] = input[key].clone();
        }
    }
    if let Some(n) = input["checkpointVersion"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
    {
        out["checkpointVersion"] = json!(n.floor() as u64);
    }
    if let Some(refs) = input["coldHistoryRefs"].as_array() {
        out["coldHistoryRefs"] = json!(
            refs.iter()
                .filter(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
                .collect::<Vec<_>>()
        );
    }
    if let Some(raw) = input.get("historySelection") {
        let selection = normalize_compaction_history_selection(raw)
            .ok_or("compaction_history_selection_invalid")?;
        if summary.trim().is_empty() {
            return Err("compaction_history_selection_invalid");
        }
        out["historySelection"] = json!(selection);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_ts_selection_validation_and_marker_construction_match() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/compaction-v1.json"
        ))
        .unwrap();
        assert_eq!(
            CANONICAL_HISTORY_PROJECTOR_VERSION,
            LIMITS["projectorVersion"].as_u64().unwrap()
        );
        for row in f["normalization"].as_array().unwrap() {
            assert_eq!(
                json!(normalize_compaction_history_selection(&row["input"])),
                row["expected"]
            );
        }
        for row in f["markerCases"].as_array().unwrap() {
            assert_eq!(
                build_compaction_marker(&row["input"]).unwrap(),
                row["expected"]
            );
        }
    }
}
