//! Explicit turn retry history. Only completed call/result pairs are durable;
//! opaque live reasoning, signatures and unfinished provider deltas never enter it.
use super::{NativeModel, Value, json};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub(super) const MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderCheckpoint {
    conversation_id: String,
    anchors: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) wake_event_ids: Vec<String>,
    provider: String,
    provider_id: String,
    model: String,
    route: String,
    pub(super) messages: Vec<Value>,
}

impl ProviderCheckpoint {
    pub(super) fn new(model: &NativeModel, conversation_id: &str, anchors: &[String]) -> Self {
        Self {
            conversation_id: conversation_id.into(),
            anchors: anchors.to_vec(),
            wake_event_ids: Vec::new(),
            provider: model.provider().into(),
            provider_id: model.provider_id().into(),
            model: model.model_id().into(),
            route: model.checkpoint_route(),
            messages: Vec::new(),
        }
    }

    pub(super) fn matches(
        &self,
        model: &NativeModel,
        conversation_id: &str,
        anchors: &[String],
    ) -> bool {
        self.conversation_id == conversation_id
            && self.anchors == anchors
            && self.provider == model.provider()
            && self.provider_id == model.provider_id()
            && self.model == model.model_id()
            && self.route == model.checkpoint_route()
    }

    pub(super) fn has_call_id(&self, id: &str) -> bool {
        self.messages
            .iter()
            .any(|message| message["tool_call_id"] == id)
    }

    /// Admit only structurally complete, adjacent batches. Rebuild a narrow
    /// canonical shape instead of letting disk fields inject wire-only content.
    pub(super) fn canonical_messages(&self) -> Option<Vec<Value>> {
        if self.messages.is_empty() {
            return None;
        }
        let mut ids = HashSet::new();
        let mut canonical = Vec::with_capacity(self.messages.len());
        let mut messages = self.messages.iter();
        while let Some(assistant) = messages.next() {
            let calls = assistant["tool_calls"]
                .as_array()
                .filter(|v| !v.is_empty())?;
            if assistant["role"] != "assistant"
                || !(assistant["content"].is_null() || assistant["content"].is_string())
            {
                return None;
            }
            let mut canonical_calls = Vec::with_capacity(calls.len());
            let mut results = Vec::with_capacity(calls.len());
            for call in calls {
                let id = call["id"]
                    .as_str()
                    .filter(|v| !v.is_empty() && v.len() <= 512)?;
                let name = call["function"]["name"]
                    .as_str()
                    .filter(|v| !v.is_empty() && v.len() <= 200)?;
                let args = call["function"]["arguments"].as_str()?;
                let result = messages.next()?;
                if call["type"] != "function"
                    || !ids.insert(id)
                    || !serde_json::from_str::<Value>(args).ok()?.is_object()
                    || result["role"] != "tool"
                    || result["tool_call_id"] != id
                {
                    return None;
                }
                canonical_calls.push(json!({"id": id, "name": name, "arguments": args}));
                results.push(json!({"role": "tool", "toolCallId": id, "name": name,
                    "content": result["content"].as_str()?}));
            }
            canonical.push(json!({"role": "assistant", "content": assistant["content"], "toolCalls": canonical_calls}));
            canonical.extend(results);
        }
        Some(canonical)
    }
}

/// Only successful reads may satisfy a repeated request; failures can be tried again.
/// Search newest first so a later completed read supersedes an earlier one.
pub(super) fn completed_reads(messages: &[Value]) -> Vec<(Value, String)> {
    let mut reads = Vec::new();
    let mut messages = messages.iter();
    while let Some(assistant) = messages.next() {
        for call in assistant["toolCalls"].as_array().into_iter().flatten() {
            let Some(result) = messages.next() else { break };
            if call["name"] == "read_file"
                && let Some(args) = call["arguments"]
                    .as_str()
                    .and_then(|s| serde_json::from_str(s).ok())
                && let Some(content) = result["content"].as_str()
                && let Ok(output) = serde_json::from_str::<Value>(content)
                && output.is_object()
                && output["error"].is_null()
                && (output["kind"] == "local_file_ref" || output["content"].is_string())
            {
                reads.push((args, content.to_owned()));
            }
        }
    }
    reads.reverse();
    reads
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NativeProjectHost;
    use crate::runner::{TurnEndKind, turn_trace_path};
    use crate::test_model::{
        ScriptHandler, mock_model, sse_text, sse_tool_call, start_mock_server,
    };
    use peer_runtime::CancellationToken;
    use std::fs;
    use tempfile::tempdir;

    #[tokio::test]
    async fn explicit_retry_replays_native_pair_without_reading_again() {
        exercise_retry(Some(true)).await;
    }

    #[tokio::test]
    async fn incompatible_route_falls_back_to_retry_summary() {
        exercise_retry(Some(false)).await;
    }

    #[tokio::test]
    async fn missing_checkpoint_falls_back_to_retry_summary() {
        exercise_retry(None).await;
    }

    async fn exercise_retry(compatible: Option<bool>) {
        let home = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let file = workspace.path().join("fixture.txt");
        let old_text = "original checkpoint content";
        let new_text = "new content after interruption";
        fs::write(&file, old_text).unwrap();
        let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
        let (entry, profile) = host.bind_workspace(workspace.path(), Some("Test")).unwrap();
        let ws = &entry.workspace_id;
        let conversation = profile.agent_conversation_id.unwrap();
        host.runner().set_retry_delays_ms(vec![]);
        host.submit_user_input(ws, "checkpoint-input", "Read fixture.txt", None)
            .unwrap();

        let read = |id| sse_tool_call(id, "read_file", &json!({"path": "fixture.txt"}));
        let retry_steps = || -> Vec<ScriptHandler> {
            vec![
                Box::new(move |_| read("provider-repeat")),
                Box::new(|_| sse_text("The fixture has been read.")),
            ]
        };
        let mut steps: Vec<ScriptHandler> = vec![
            Box::new(move |_| read("provider-original")),
            // Partial text followed by EOF, without a finish reason or [DONE].
            Box::new(|_| {
                let partial = json!({"choices": [{"index": 0, "delta": {"content": "unfinished reply"}, "finish_reason": null}]});
                format!("data: {partial}\n\n")
            }),
        ];
        if compatible != Some(false) {
            steps.extend(retry_steps());
        }
        let server = start_mock_server(steps);
        let model = mock_model(&server.endpoint);
        let cancel = CancellationToken::new();
        let interrupted = host
            .tick_foreground(ws, &model, json!({}), &cancel)
            .await
            .unwrap()
            .last_turn
            .unwrap();
        assert_eq!(
            interrupted.end,
            TurnEndKind::Failed {
                code: "model_stream_incomplete".into()
            }
        );
        assert_eq!(interrupted.tool_calls, 1);

        let path = turn_trace_path(home.path(), ws, &interrupted.turn_id).unwrap();
        let mut trace: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let checkpoint = &trace["providerCheckpoint"];
        assert_eq!(checkpoint["conversationId"], conversation);
        assert_eq!(checkpoint["anchors"], json!(["input-checkpoint-input"]));
        assert_eq!(checkpoint["provider"], model.provider());
        assert_eq!(checkpoint["providerId"], model.provider_id());
        assert_eq!(checkpoint["model"], model.model_id());
        assert_eq!(checkpoint["route"], model.checkpoint_route());
        let saved = checkpoint["messages"].as_array().unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0]["role"], "assistant");
        let original_call = saved[0]["tool_calls"].clone();
        assert_eq!(
            original_call,
            json!([{"id":"provider-original","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"fixture.txt\"}"}}])
        );
        assert_eq!(saved[1]["role"], "tool");
        assert_eq!(saved[1]["tool_call_id"], "provider-original");
        assert!(saved[1]["content"].as_str().unwrap().contains(old_text));
        assert!(!checkpoint.to_string().contains("unfinished reply"));
        if compatible.is_none() {
            trace.as_object_mut().unwrap().remove("providerCheckpoint");
            fs::write(&path, serde_json::to_vec(&trace).unwrap()).unwrap();
        }

        fs::write(file, new_text).unwrap();
        let other_route = (compatible == Some(false)).then(|| start_mock_server(retry_steps()));
        let (retry_server, offset) = other_route.as_ref().map_or((&server, 2), |s| (s, 0));
        let retry_model = mock_model(&retry_server.endpoint);
        assert_eq!(
            host.retry_turn(ws, &interrupted.turn_id).unwrap()["requeued"],
            1
        );
        let retried = host
            .tick_foreground(ws, &retry_model, json!({}), &cancel)
            .await
            .unwrap()
            .last_turn
            .unwrap();
        assert!(
            matches!(retried.end, TurnEndKind::ReplyCommitted { .. }),
            "{retried:?}"
        );
        let requests = retry_server.requests.lock().unwrap();
        assert_eq!(requests.len(), offset + 2);
        let initial = requests[offset]["messages"].as_array().unwrap();
        let after_repeat = requests[offset + 1]["messages"].as_array().unwrap();
        let result = after_repeat.last().unwrap()["content"].as_str().unwrap();
        let retry_path = turn_trace_path(home.path(), ws, &retried.turn_id).unwrap();
        let retry_trace: Value = serde_json::from_slice(&fs::read(retry_path).unwrap()).unwrap();
        if compatible == Some(true) {
            let pair = initial
                .windows(2)
                .find(|pair| pair[0]["tool_calls"] == original_call)
                .unwrap();
            assert_eq!(pair[1]["role"], "tool");
            assert_eq!(pair[1]["tool_call_id"], "provider-original");
            assert!(pair[1]["content"].as_str().unwrap().contains(old_text));
            assert!(result.contains(old_text) && !result.contains(new_text));
            assert!(
                retry_trace["rounds"][0]["toolCalls"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        } else {
            assert!(
                !initial
                    .iter()
                    .any(|m| m["role"] == "tool" || m.get("tool_calls").is_some())
            );
            assert!(
                initial[0]["content"]
                    .as_str()
                    .unwrap()
                    .contains("Prior stopped/failed attempt continuity")
            );
            assert!(result.contains(new_text) && !result.contains(old_text));
            assert_eq!(
                retry_trace["rounds"][0]["toolCalls"][0]["name"],
                "read_file"
            );
        }
    }
}
