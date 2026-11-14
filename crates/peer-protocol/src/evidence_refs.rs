use serde_json::Value;
use std::collections::HashSet;

/// JavaScript String.trim semantics used by existing persisted contracts.
pub fn javascript_trim(text: &str) -> &str {
    text.trim_matches(|c| matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceRefError {
    LimitExceeded,
}

/// Collects known fields from a governed execution only, in insertion order.
/// Arbitrary tool output and assistant text never register themselves as Evidence.
/// These refs do not prove a successful execution, delivery or acceptance.
pub fn collect_tool_evidence_refs(
    tool_call_id: Option<&str>,
    execution: &Value,
) -> Result<Vec<String>, EvidenceRefError> {
    collect_tool_result_evidence_refs(tool_call_id, &execution["result"])
}

/// Same collector at the Host's result seam, without cloning a result envelope.
pub fn collect_tool_result_evidence_refs(
    tool_call_id: Option<&str>,
    result: &Value,
) -> Result<Vec<String>, EvidenceRefError> {
    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    let mut bytes = 0usize;
    let mut add = |text: &str| -> Result<(), EvidenceRefError> {
        let text = javascript_trim(text);
        if text.is_empty() || seen.contains(text) {
            return Ok(());
        }
        if refs.len() >= 1024 || text.len() > 8192 || bytes.saturating_add(text.len()) > 256 * 1024
        {
            return Err(EvidenceRefError::LimitExceeded);
        }
        bytes += text.len();
        seen.insert(text.to_owned());
        refs.push(text.to_owned());
        Ok(())
    };
    if let Some(id) = tool_call_id
        .map(javascript_trim)
        .filter(|id| !id.is_empty())
    {
        if id.len() > 8192 - "tool-result://".len() {
            return Err(EvidenceRefError::LimitExceeded);
        }
        add(&format!("tool-result://{id}"))?;
    }
    let evidence = &result["evidence"];
    let preview = &result["outputPreview"];
    for field in [
        &evidence["refs"],
        &evidence["artifactRefs"],
        &preview["artifactRef"],
        &preview["artifactRefs"],
        &preview["localToolResultRef"]["artifactRef"],
        &preview["localToolResultRef"]["artifactRefs"],
    ] {
        if let Some(text) = field.as_str() {
            add(text)?;
        } else if let Some(array) = field.as_array() {
            if array.len() > 65_536 {
                return Err(EvidenceRefError::LimitExceeded);
            }
            for item in array {
                if let Some(text) = item.as_str() {
                    add(text)?;
                }
            }
        }
    }
    Ok(refs)
}
