use super::*;
use peer_store::{ToolArtifactStore, WebArtifactStore};
pub(super) fn save(
    home: &Path,
    conversation: &str,
    call: &str,
    args: &Value,
    fetch: http::Fetched,
    guard: &Guard,
) -> EffectOutcome {
    let mut effect = false;
    let mut known = None;
    let result = (|| -> Result<(Value, Vec<String>), &'static str> {
        guard.check()?;
        let http::Fetched {
            requested,
            final_url,
            mime,
            status,
            bytes,
            secrets,
            started_at,
        } = fetch;
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        drop(bytes);
        let text = text::normalize(raw, &mime, &|| guard.interrupted())?;
        let mut redacted = false;
        let mut protect = |value: &str, limit: usize| {
            let (s, r) = text::protect(value, &secrets, limit)?;
            redacted |= r;
            Ok::<String, &'static str>(s)
        };
        let title = protect(&text.title, 65536)?;
        let content = protect(&text.content, 8 * 1024 * 1024)?;
        if content.encode_utf16().count() > 2_000_000 {
            return Err("web_redaction_limit");
        }
        let requested = protect(&requested, 16384)?;
        let final_url = protect(&final_url, 16384)?;
        let mime = protect(&mime, 8192)?;
        let (source_summary, summary_cut) = text::prefix(&content, 4000);
        let summary = if summary_cut {
            format!("{source_summary}\n...[content stored in artifact]")
        } else {
            source_summary.to_owned()
        };
        guard.check()?;
        effect = true;
        let reference = ToolArtifactStore::new(home)
            .publish_utf8(conversation, &content, &|| guard.interrupted())
            .map_err(|e| guard.error.get().unwrap_or(e.code()))?;
        known = Some(reference.clone());
        guard.check()?;
        let fetch_id = uuid::Uuid::new_v4().to_string();
        let at = crate::capability::now();
        let date = &at[..10];
        let metadata = json!({"schemaVersion":1,"fetchId":fetch_id,"toolCallId":call,"requestedUrl":requested,"finalUrl":final_url,"title":title,"contentType":mime,"httpStatus":status,"fetchMode":"http","startedAt":started_at,"completedAt":at,"contentTruncated":text.truncated,"contentChars":content.encode_utf16().count(),"contentLines":content.split('\n').count(),"sourceContentChars":text.source_units,"redacted":redacted,"nativeContentRef":reference,"contentHash":reference.sha256});
        let published = WebArtifactStore::new(home)
            .publish(date, &fetch_id, &content, &metadata, &|| {
                guard.interrupted()
            })
            .map_err(|e| guard.error.get().unwrap_or(e.code))?;
        guard.check()?;
        let output = json!({"status":"success","requestedUrl":requested,"finalUrl":final_url,"title":title,"summary":summary,"contentType":mime,"httpStatus":status,"fetchMode":"http","waitForRenderRequested":args["waitForRender"]!=false,"rendered":false,"artifactRef":published.reference,"artifactRefs":published.artifact_refs,"contentTruncated":text.truncated,"redacted":redacted,"nativeContentRef":reference,"retrieval":{"tool":"read_tool_result","arguments":{"reference":reference,"offset":0,"length":4096},"note":"Saved static HTTP observation, not a live page or verified conclusion."}});
        Ok((output, published.artifact_refs))
    })();
    match result {
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
            let code = guard.error.get().unwrap_or(code);
            let mut out = EffectOutcome::failed(if effect {
                "execution_outcome_unknown"
            } else {
                code
            });
            out.output = json!({"reason":code,"publicationUnknown":effect});
            if let Some(reference) = known {
                out.output["nativeContentRef"] = json!(reference)
            };
            if code == "CANCELLED" && !effect {
                out.status = "cancelled"
            }
            out
        }
    }
}
