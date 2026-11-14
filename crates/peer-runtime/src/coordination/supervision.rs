//! Durable supervision receipts. Delivery, admission and effect stay distinct.
use super::{
    bucket, id, put,
    value::{list, merge, num, remove, truth},
};
use serde_json::{Value, json};
const BUCKETS: &[&str] = &[
    "agentMessages",
    "agentRequests",
    "agentCommands",
    "workNotes",
    "contextWindows",
];
fn receipt(v: &Value) -> bool {
    ["queued", "observed"].contains(&v["delivery"].as_str().unwrap_or(""))
        && ["not_requested", "pending", "admitted", "rejected"]
            .contains(&v["admission"].as_str().unwrap_or(""))
        && ["not_requested", "pending", "applied", "unknown", "rejected"]
            .contains(&v["effect"].as_str().unwrap_or(""))
}
pub(super) fn reduce(mut next: Value, e: &Value) -> Result<Value, &'static str> {
    for b in BUCKETS {
        bucket(&mut next, b)?;
    }
    match e["kind"].as_str().unwrap_or("") {
        "agent_message_committed" => {
            let message = &e["message"];
            let command = &e["receipt"];
            if !truth(&message["messageId"])
                || !truth(&message["operationId"])
                || !truth(&message["recipientConversationId"])
                || !receipt(command)
                || command.get("operationId") != message.get("operationId")
                || command.get("messageId") != message.get("messageId")
                || command.get("goalRevision") != message.get("goalRevision")
                || command.get("sessionId") != message.get("sessionId")
                || command["delivery"] != "queued"
                || num(&message["goalRevision"]).is_none()
                || !truth(&message["payloadHash"])
            {
                return Err("agent_message_invalid");
            }
            let key = id(&message["messageId"])?;
            let previous = &next["agentMessages"][key];
            if !previous.is_null() {
                if previous["payloadHash"] != message["payloadHash"] {
                    return Err("agent_operation_conflict");
                }
                return Ok(next);
            }
            if truth(&e["answer"]) {
                let answer = &e["answer"];
                let request = &next["agentRequests"][id(&answer["requestId"])?];
                if request.is_null()
                    || request["status"] != "open"
                    || request["revision"] != answer["expectedRequestRevision"]
                    || request.get("goalRevision") != message.get("goalRevision")
                    || request.get("sessionId") != message.get("sessionId")
                    || request["responder"] == "user"
                        && (!truth(&answer["sourceInputId"])
                            || answer.get("userRequestRef") != request.get("userRequestRef"))
                {
                    return Err("agent_request_stale");
                }
                let mut updated = merge(
                    request,
                    &json!({"status":"answered","answerId":message["messageId"],"revision":num(&request["revision"]).ok_or("agent_request_stale")?+1}),
                );
                let request_key = id(&updated["requestId"])?.to_owned();
                put(
                    &mut next,
                    "agentRequests",
                    &request_key,
                    std::mem::take(&mut updated),
                )?;
            }
            if truth(&e["request"]) {
                let request = &e["request"];
                if request.get("requestId") != message.get("messageId")
                    || request["revision"] != 1
                    || request["status"] != "open"
                    || request["responder"] != "parent"
                    || request.get("sessionId") != message.get("sessionId")
                    || request.get("goalRevision") != message.get("goalRevision")
                {
                    return Err("agent_request_invalid");
                }
                let request_key = id(&request["requestId"])?;
                if next["agentRequests"].get(request_key).is_some() {
                    return Err("agent_request_exists");
                }
                if next["agentRequests"]
                    .as_object()
                    .unwrap()
                    .values()
                    .any(|r| {
                        r.get("sessionId") == request.get("sessionId") && r["status"] == "open"
                    })
                {
                    return Err("agent_request_already_open");
                }
                put(&mut next, "agentRequests", request_key, request.clone())?;
            }
            put(
                &mut next,
                "agentMessages",
                key,
                merge(message, &json!({"sequence":e["revision"]})),
            )?;
            put(
                &mut next,
                "agentCommands",
                id(&message["operationId"])?,
                command.clone(),
            )?;
        }
        "agent_command_updated" => {
            let key = id(&e["operationId"])?;
            let old = &next["agentCommands"][key];
            if old.is_null()
                || old.get("goalRevision") != e.get("goalRevision")
                || old.get("executionEpoch") != e.get("executionEpoch")
            {
                return Err("agent_command_stale");
            }
            let mut patch = if e["patch"].is_null() {
                json!({})
            } else {
                e["patch"].clone()
            };
            if !super::value::allowed(
                &patch,
                &[
                    "delivery",
                    "admission",
                    "effect",
                    "error",
                    "observedAt",
                    "attemptRef",
                ],
            ) || !receipt(&merge(old, &patch))
            {
                return Err("agent_command_patch_invalid");
            }
            if patch["effect"] == "applied"
                && ((if truth(&patch["delivery"]) {
                    &patch["delivery"]
                } else {
                    &old["delivery"]
                }) != "observed"
                    || (if truth(&patch["admission"]) {
                        &patch["admission"]
                    } else {
                        &old["admission"]
                    }) != "admitted"
                    || !truth(&patch["attemptRef"]))
            {
                return Err("agent_effect_unproven");
            }
            if old["delivery"] == "observed" && patch["delivery"] == "queued" {
                remove(&mut patch, "delivery")
            }
            if old["effect"] == "applied" {
                for key in ["effect", "admission", "error"] {
                    remove(&mut patch, key)
                }
            }
            let mut updated = merge(old, &patch);
            if patch.get("error").is_some_and(Value::is_null) {
                remove(&mut updated, "error")
            }
            put(&mut next, "agentCommands", key, updated)?;
        }
        "agent_execution_completed" => {
            if !e["attemptRef"].as_str().is_some_and(|s| !s.is_empty())
                || !e["messageIds"].is_array()
                || list(&e["messageIds"]).is_empty()
                || list(&e["messageIds"]).len() > 100
            {
                return Err("agent_execution_unproven");
            }
            for key in list(&e["messageIds"]) {
                let message = &next["agentMessages"][id(key)?];
                let command = &next["agentCommands"][message["operationId"].as_str().unwrap_or("")];
                if message.is_null()
                    || message.get("recipientConversationId") != e.get("conversationId")
                    || command["delivery"] != "observed"
                    || command["admission"] == "rejected"
                    || !["pending", "unknown", "applied"]
                        .contains(&command["effect"].as_str().unwrap_or(""))
                {
                    return Err("agent_execution_unproven");
                }
                if command["effect"] != "applied" {
                    let command_key = id(&message["operationId"])?.to_owned();
                    let mut updated = merge(
                        command,
                        &json!({"admission":"admitted","effect":"applied","attemptRef":e["attemptRef"],"completionRecorded":true}),
                    );
                    remove(&mut updated, "error");
                    put(&mut next, "agentCommands", &command_key, updated)?;
                }
            }
        }
        "agent_context_observed" => {
            for key in list(&e["messageIds"]) {
                let message = &next["agentMessages"][id(key)?];
                if message.is_null()
                    || message.get("recipientConversationId") != e.get("conversationId")
                {
                    return Err("agent_observation_out_of_scope");
                }
                let command_key = id(&message["operationId"])?.to_owned();
                let updated = merge(
                    &next["agentCommands"][&command_key],
                    &json!({"delivery":"observed","observedAt":e["at"]}),
                );
                put(&mut next, "agentCommands", &command_key, updated)?;
            }
        }
        "agent_request_cancelled" | "agent_request_escalated" => {
            let request = &next["agentRequests"][id(&e["requestId"])?];
            let escalated = e["kind"] == "agent_request_escalated";
            if request.is_null()
                || request["status"] != "open"
                || request["revision"] != e["expectedRevision"]
                || escalated
                    && (!truth(&e["userRequestRef"])
                        || request["responder"] == "user"
                            && e.get("previousUserRequestRef") != request.get("userRequestRef"))
            {
                return Err("agent_request_stale");
            }
            let key = id(&request["requestId"])?.to_owned();
            let patch = if escalated {
                json!({"responder":"user","userRequestRef":e["userRequestRef"],"revision":num(&request["revision"]).ok_or("agent_request_stale")?+1})
            } else {
                let mut p = json!({"status":"cancelled","revision":num(&request["revision"]).ok_or("agent_request_stale")?+1});
                if let Some(v) = e.get("reason") {
                    p["reason"] = v.clone()
                }
                p
            };
            let updated = merge(request, &patch);
            put(&mut next, "agentRequests", &key, updated)?;
        }
        "work_note_written" => {
            let note = &e["note"];
            let key = id(&note["noteId"]).map_err(|_| "work_note_conflict")?;
            let current = &next["workNotes"][key];
            let rev = num(&e["expectedRevision"]).ok_or("work_note_conflict")?;
            if !truth(&note["workId"])
                || !truth(&note["conversationId"])
                || num(&current["revision"]).unwrap_or(0) != rev
                || !current.is_null()
                    && (current.get("workId") != note.get("workId")
                        || current.get("conversationId") != note.get("conversationId"))
            {
                return Err("work_note_conflict");
            }
            put(
                &mut next,
                "workNotes",
                key,
                merge(note, &json!({"revision":rev+1})),
            )?;
        }
        "context_window_opened" => {
            let window = &e["window"];
            let key = id(&window["windowId"]).map_err(|_| "context_window_invalid")?;
            if !truth(&window["workId"])
                || !truth(&window["conversationId"])
                || !truth(&window["budgetRef"])
                || window["state"] != "prepared"
            {
                return Err("context_window_invalid");
            }
            if truth(&window["previousWindowId"])
                && next["contextWindows"]
                    .get(id(&window["previousWindowId"])?)
                    .is_none()
            {
                return Err("context_window_previous_missing");
            }
            if let Some(old) = next["contextWindows"].get(key)
                && peer_protocol::javascript_json_string(old).ok()
                    != peer_protocol::javascript_json_string(window).ok()
            {
                return Err("context_window_conflict");
            }
            put(&mut next, "contextWindows", key, window.clone())?;
        }
        _ => return Err("agent_supervision_event_unknown"),
    }
    Ok(next)
}
