use super::*;
use crate::{
    effect_admission::BlockingAdmission,
    tool_result_content::{ArchivePolicy, archive_with_check},
};
use peer_store::ToolArtifactStore;
fn prefix(value: &str, units: usize) -> String {
    let mut used = 0;
    value
        .chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= units
        })
        .collect()
}
fn size(value: &Value) -> usize {
    value.to_string().encode_utf16().count()
}
fn preview(
    full: &Value,
    reference: &peer_store::ToolArtifactRef,
    path: &Path,
    limit: u64,
    guard: &BlockingAdmission,
) -> Result<Value, &'static str> {
    let mut out = full.clone();
    out["origin"] = json!(
        full["origin"]
            .as_array()
            .into_iter()
            .flatten()
            .take(3)
            .map(|v| prefix(v.as_str().unwrap_or(""), 400))
            .collect::<Vec<_>>()
    );
    out["commits"]
        .as_array_mut()
        .ok_or("git_query_invalid_observation")?
        .truncate(limit as usize);
    if let Some(entries) = out["status"]["entries"].as_array_mut() {
        entries.truncate(limit as usize);
        out["status"]["truncated"] =
            json!(entries.len() < full["status"]["entries"].as_array().unwrap().len());
    }
    out["artifactPath"] = json!(path);
    out["retrievalHint"] = json!({"tool":"read_file","path":path});
    out["nativeContentRef"] = json!(reference);
    out["retrieval"] = json!({"tool":"read_tool_result","arguments":{"reference":reference,"offset":0,"length":4096},"note":"Saved Git observation; read omitted entries from this immutable JSON, without rerunning Git."});
    loop {
        guard.check().map_err(|e| e.0)?;
        let cut = out["status"]["truncated"] == true
            || out["commits"].as_array().unwrap().len() < full["commits"].as_array().unwrap().len()
            || out["origin"] != full["origin"];
        out["contextPreviewTruncated"] = json!(cut);
        if size(&out) <= 4000 {
            break;
        }
        if let Some(entries) = out["status"]["entries"]
            .as_array_mut()
            .filter(|a| !a.is_empty())
        {
            entries.pop();
            out["status"]["truncated"] = json!(true);
        } else if let Some(commits) = out["commits"].as_array_mut().filter(|a| !a.is_empty()) {
            commits.pop();
        } else {
            out["contextPreviewTruncated"] = json!(true);
            break;
        }
    }
    Ok(out)
}
pub(super) fn save(
    home: &Path,
    conversation: &str,
    observation: Value,
    limit: u64,
    guard: &BlockingAdmission,
) -> EffectOutcome {
    let mut full = observation;
    full["kind"] = json!("local_git_observation");
    let store = ToolArtifactStore::new(home);
    let mut effect = false;
    let mut known = None;
    let mut planned = None;
    let saved = (|| -> Result<(Value, Vec<String>), &'static str> {
        guard.check().map_err(|e| e.0)?;
        let reference = store
            .describe_json(conversation, &full, &|| guard.interrupted())
            .map_err(|e| guard.error().unwrap_or(e.code()))?;
        let path = store.path(conversation, &reference).map_err(|e| e.code())?;
        let mut output = preview(&full, &reference, &path, limit, guard)?;
        planned = Some(reference.clone());
        guard.check().map_err(|e| e.0)?;
        effect = true;
        let actual = store
            .publish_json(conversation, &full, &|| guard.interrupted())
            .map_err(|e| guard.error().unwrap_or(e.code()))?;
        known = Some(actual.clone());
        if actual != reference {
            return Err("git_artifact_changed");
        }
        guard.check().map_err(|e| e.0)?;
        let mut artifacts = vec![path.to_str().ok_or("git_artifact_path_invalid")?.to_owned()];
        if size(&output) > 4000 {
            let archived = archive_with_check(
                home,
                conversation,
                json!({"output":output}),
                ToolOutputKind::Structured,
                ArchivePolicy::Required,
                &|| guard.interrupted(),
            )?;
            output = archived["output"].clone();
            let stored: peer_store::ToolArtifactRef =
                serde_json::from_value(output["nativeContentRef"].clone())
                    .map_err(|_| "git_artifact_invalid")?;
            artifacts.push(
                store
                    .path(conversation, &stored)
                    .map_err(|e| e.code())?
                    .to_str()
                    .ok_or("git_artifact_path_invalid")?
                    .into(),
            );
            let mut with_legacy = output.clone();
            with_legacy["artifactPath"] = json!(path);
            with_legacy["retrievalHint"] = json!({"tool":"read_file","path":path});
            if size(&with_legacy) <= 4000 {
                output = with_legacy;
            }
        }
        guard.check().map_err(|e| e.0)?;
        if size(&output) > 4000 {
            return Err("git_query_output_limit");
        }
        Ok((output, artifacts))
    })();
    match saved {
        Ok((output, artifacts)) => EffectOutcome {
            status: "success",
            output,
            error: None,
            artifacts,
            ended: true,
            materialization: None,
            not_dispatched: false,
        },
        Err(code) => {
            let code = guard.error().unwrap_or(code);
            let mut out = EffectOutcome::failed(if effect {
                "execution_outcome_unknown"
            } else {
                code
            });
            out.output = json!({"reason":code,"publicationUnknown":effect});
            if let Some(reference) = known {
                out.output["nativeContentRef"] = json!(reference);
                if let Ok(path) = store.path(conversation, &reference) {
                    out.artifacts.push(path.to_string_lossy().into_owned());
                }
            } else if let Some(reference) = planned {
                out.output["plannedContentRef"] = json!(reference);
            }
            if code == "CANCELLED" && !effect {
                out.status = "cancelled"
            }
            out
        }
    }
}
