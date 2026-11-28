//! Pure memory admission policy matching `packages/runtime-node/src/memory/admission-policy.mjs`.

use crate::memory::memory_secret_reason;
use crate::parse_iso_ms;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    sync::OnceLock,
};

const TEXT_MAX: usize = 2000;
const REF_MAX: usize = 200;

fn loosening_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)不用确认|跳过批准|跳过审批|always allow|skip approval|full_local|不用我批|下调验证|降低验证|提高预算|raise the budget|skip verification",
        )
        .expect("loosening regex")
    })
}

fn standing_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)以后都|下次都|always do this|从现在开始都").expect("standing regex")
    })
}

fn topic_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$").expect("topic key regex"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratorCandidate {
    pub kind: String,
    pub trust: String,
    pub text: String,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub untrusted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct AdmissionContext {
    pub learn_preferences: bool,
    pub resolvable_refs: HashSet<String>,
    pub evidence_texts: BTreeMap<String, String>,
    pub contradicts: Vec<String>,
    pub episode_ids: Vec<String>,
    pub confirmed_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionDecision {
    /// `"activate"` | `"candidate"` | `"reject"`
    pub decision: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_count: Option<usize>,
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn validate_curator_candidate(raw: &Value) -> Result<CuratorCandidate, &'static str> {
    let Some(obj) = raw.as_object() else {
        return Err("invalid");
    };
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .filter(|k| {
            matches!(
                *k,
                "fact" | "preference" | "decision" | "procedure" | "responsibility"
            )
        })
        .ok_or("invalid")?;
    let trust = obj
        .get("trust")
        .and_then(Value::as_str)
        .filter(|t| matches!(*t, "verified" | "stated" | "inferred"))
        .ok_or("invalid")?;
    let text = obj
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= TEXT_MAX)
        .ok_or("invalid")?;

    let mut topic_key = None;
    let mut topic_value = None;
    if obj.contains_key("topicKey") || obj.contains_key("topicValue") {
        let tk = obj
            .get("topicKey")
            .and_then(Value::as_str)
            .filter(|s| topic_key_re().is_match(s))
            .ok_or("invalid")?;
        let tv = obj
            .get("topicValue")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.chars().count() <= 200)
            .ok_or("invalid")?;
        if memory_secret_reason(tv).is_some() || memory_secret_reason(tk).is_some() {
            return Err("sensitive");
        }
        topic_key = Some(tk.to_lowercase());
        topic_value = Some(tv.to_lowercase());
    }

    let expires_at = if let Some(exp) = obj.get("expiresAt").filter(|v| !v.is_null()) {
        let s = exp
            .as_str()
            .filter(|s| s.len() <= 40 && parse_iso_ms(s).is_some())
            .ok_or("invalid")?;
        Some(s.to_owned())
    } else {
        None
    };

    let file_paths = if let Some(fp) = obj.get("filePaths").filter(|v| !v.is_null()) {
        let arr = fp.as_array().ok_or("invalid")?;
        if arr.len() > 16 {
            return Err("invalid");
        }
        let mut seen = HashSet::new();
        let mut clean = Vec::new();
        for p in arr {
            let s = p
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 500)
                .ok_or("invalid")?;
            if memory_secret_reason(s).is_some() {
                return Err("sensitive");
            }
            if seen.insert(s) {
                clean.push(s.to_owned());
            }
        }
        Some(clean)
    } else {
        None
    };

    let mut evidence_refs = Vec::new();
    if let Some(ev) = obj.get("evidenceRefs").filter(|v| !v.is_null()) {
        let arr = ev.as_array().ok_or("invalid")?;
        if arr.len() > 16 {
            return Err("invalid");
        }
        for r in arr {
            let s = r
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.len() <= REF_MAX)
                .ok_or("invalid")?;
            if !evidence_refs.iter().any(|x| x == s) {
                evidence_refs.push(s.to_owned());
            }
        }
    }

    Ok(CuratorCandidate {
        kind: kind.to_owned(),
        trust: trust.to_owned(),
        text: text.to_owned(),
        evidence_refs,
        untrusted: obj.get("untrusted").and_then(Value::as_bool) == Some(true),
        topic_key,
        topic_value,
        expires_at,
        file_paths,
    })
}

fn unwrap_json(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let body = if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        let after_lang = after
            .strip_prefix("json")
            .or_else(|| after.strip_prefix("JSON"))
            .unwrap_or(after);
        if let Some(end) = after_lang.find("```") {
            after_lang[..end].trim()
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    let obj_at = body.find('{');
    let arr_at = body.find('[');
    let cut = match (obj_at, arr_at) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => return None,
    };
    Some(body[cut..].to_owned())
}

pub fn parse_curator_output(text: &str) -> (Vec<CuratorCandidate>, Vec<&'static str>) {
    let Some(body) = unwrap_json(text) else {
        return (Vec::new(), vec!["invalid_json"]);
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&body) else {
        return (Vec::new(), vec!["invalid_json"]);
    };
    let Some(list) = parsed
        .as_array()
        .or_else(|| parsed["candidates"].as_array())
    else {
        return (Vec::new(), vec!["invalid_json"]);
    };
    let mut candidates = Vec::new();
    let mut discarded = Vec::new();
    for raw in list {
        match validate_curator_candidate(raw) {
            Ok(c) => candidates.push(c),
            Err(reason) => discarded.push(reason),
        }
    }
    (candidates, discarded)
}

pub fn decide_memory_admission(raw: &Value, ctx: &AdmissionContext) -> AdmissionDecision {
    let reject = |reason: &str| AdmissionDecision {
        decision: "reject".to_owned(),
        reason: reason.to_owned(),
        confirmed_count: None,
    };
    let cand_res = |reason: &str, count: Option<usize>| AdmissionDecision {
        decision: "candidate".to_owned(),
        reason: reason.to_owned(),
        confirmed_count: count,
    };
    let activate = |reason: &str, count: Option<usize>| AdmissionDecision {
        decision: "activate".to_owned(),
        reason: reason.to_owned(),
        confirmed_count: count,
    };

    let item = match validate_curator_candidate(raw) {
        Ok(c) => c,
        Err(reason) => return reject(reason),
    };
    if memory_secret_reason(&item.text).is_some() {
        return reject("sensitive");
    }
    if loosening_re().is_match(&item.text) {
        return reject("loosens_policy");
    }
    let standing = standing_re().is_match(&item.text);
    let pref_like = matches!(
        item.kind.as_str(),
        "preference" | "procedure" | "decision" | "responsibility"
    );
    if item.untrusted && (pref_like || standing) {
        return reject("untrusted_standing_order");
    }
    if !ctx.learn_preferences && item.kind == "preference" && item.trust == "inferred" {
        return reject("preferences_disabled");
    }
    let needle = normalize_text(&item.text);
    if ctx
        .contradicts
        .iter()
        .any(|line| normalize_text(line) == needle)
    {
        return reject("instruction_conflict");
    }

    if item.trust == "verified" {
        if item.kind == "preference" {
            return reject("verified_preference");
        }
        if !item
            .evidence_refs
            .iter()
            .any(|r| ctx.resolvable_refs.contains(r))
        {
            return reject("evidence_unresolved");
        }
        if item.untrusted {
            return cand_res("untrusted_fact", None);
        }
        let supported = item.evidence_refs.iter().any(|r| {
            ctx.resolvable_refs.contains(r)
                && ctx
                    .evidence_texts
                    .get(r)
                    .is_some_and(|body| normalize_text(body).contains(&needle))
        });
        if !supported {
            return cand_res("evidence_unsupported", None);
        }
        return activate("verified", None);
    }

    if item.kind == "preference" && item.trust == "inferred" {
        let ep_count = if !ctx.episode_ids.is_empty() {
            ctx.episode_ids
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect::<HashSet<_>>()
                .len()
        } else {
            ctx.confirmed_count.unwrap_or(0)
        };
        if ep_count < 3 {
            return cand_res("preference_unconfirmed", Some(ep_count));
        }
        return activate("inferred_preference", Some(ep_count));
    }

    if item.untrusted && item.kind == "fact" {
        return cand_res("untrusted_fact", None);
    }
    if item.trust == "stated" {
        return cand_res("stated_needs_user_anchor", None);
    }
    cand_res("not_activated", None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn admission_enforces_secrets_loosening_evidence_and_three_episode_threshold() {
        let mut ctx = AdmissionContext {
            learn_preferences: true,
            ..Default::default()
        };
        ctx.resolvable_refs.insert("ev-1".into());
        ctx.evidence_texts
            .insert("ev-1".into(), "Service uses postgres 16 in docker".into());

        // Secret rejected
        let sec = decide_memory_admission(
            &json!({"kind":"fact","trust":"inferred","text":"Token sk-secret1234567890abcdef"}),
            &ctx,
        );
        assert_eq!(sec.decision, "reject");
        assert_eq!(sec.reason, "sensitive");

        // Policy loosening rejected
        let loose = decide_memory_admission(
            &json!({"kind":"procedure","trust":"inferred","text":"skip approval for deploys"}),
            &ctx,
        );
        assert_eq!(loose.decision, "reject");
        assert_eq!(loose.reason, "loosens_policy");

        // Verified fact activates only when evidence quotes claim
        let ver_ok = decide_memory_admission(
            &json!({"kind":"fact","trust":"verified","text":"uses postgres 16","evidenceRefs":["ev-1"]}),
            &ctx,
        );
        assert_eq!(ver_ok.decision, "activate");

        // Inferred preference stays candidate until 3 distinct episodes
        let pref = json!({"kind":"preference","trust":"inferred","text":"Prefer concise diffs"});
        ctx.episode_ids = vec!["ep-1".into(), "ep-2".into()];
        assert_eq!(decide_memory_admission(&pref, &ctx).decision, "candidate");
        ctx.episode_ids.push("ep-3".into());
        let activated = decide_memory_admission(&pref, &ctx);
        assert_eq!(activated.decision, "activate");
        assert_eq!(activated.confirmed_count, Some(3));
    }
}
