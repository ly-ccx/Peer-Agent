use super::{Connection, Pending};
use peer_runtime::{
    CancellationToken,
    capability::CapabilityError,
    conversation_host::{ConversationEvent, ConversationOutput},
    session_host::{LocalPermissionDecision, PermissionInput},
};
use serde_json::{Value, json};
use std::{cell::RefCell, future::Future, pin::Pin, rc::Rc, time::Duration};

pub(super) struct ApprovalPort {
    connection: Rc<Connection>,
    session: String,
}
impl ApprovalPort {
    pub(super) fn new(connection: Rc<Connection>, session: String) -> Self {
        Self {
            connection,
            session,
        }
    }
}
struct PendingApproval<'a> {
    pending: &'a Pending,
    id: String,
}
impl Drop for PendingApproval<'_> {
    fn drop(&mut self) {
        self.pending.borrow_mut().remove(&self.id);
    }
}
impl PermissionInput for ApprovalPort {
    fn decide<'a>(
        &'a mut self,
        prompt: Value,
        cancel: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = LocalPermissionDecision> + 'a>> {
        Box::pin(async move {
            use LocalPermissionDecision::{Approve, Cancel, Deny, Timeout};
            if cancel.is_cancelled() {
                return Cancel;
            }
            let (Some(call), Some(tool)) = (prompt["toolCallId"].as_str(), prompt["tool"].as_str())
            else {
                return Deny;
            };
            let Some(next) = self.connection.next_approval.get().checked_add(1) else {
                return Deny;
            };
            self.connection.next_approval.set(next);
            let approval = PendingApproval {
                pending: &self.connection.pending,
                id: format!("peer-approval-{next}"),
            };
            let (reply, receive) = tokio::sync::oneshot::channel();
            approval
                .pending
                .borrow_mut()
                .insert(approval.id.clone(), reply);
            let message = json!({
                "jsonrpc":"2.0",
                "id":approval.id,
                "method":"session/request_permission",
                "params":{"sessionId":self.session,"toolCall":{"toolCallId":call,"title":tool,"status":"pending"},
                    "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
                               {"optionId":"deny","name":"Reject","kind":"reject_once"}]}
            });
            if self.connection.writer.send(&message).await.is_err() {
                return Cancel;
            }
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Cancel,
                reply = receive => match reply {
                    Ok(response) if response["result"]["outcome"]["outcome"] == "selected"
                        && response["result"]["outcome"]["optionId"] == "allow-once" => Approve,
                    _ => Deny,
                },
                _ = tokio::time::sleep(Duration::from_secs(60)) => Timeout,
            }
        })
    }
}

pub(super) struct OutputPort {
    connection: Rc<Connection>,
    session: String,
    conversation: Rc<RefCell<Option<String>>>,
    shown_text_bytes: usize,
}
impl OutputPort {
    pub(super) fn new(
        connection: Rc<Connection>,
        session: String,
        conversation: Rc<RefCell<Option<String>>>,
    ) -> Self {
        Self {
            connection,
            session,
            conversation,
            shown_text_bytes: 0,
        }
    }
}
impl ConversationOutput for OutputPort {
    fn publish<'a>(
        &'a mut self,
        event: ConversationEvent<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilityError>> + 'a>> {
        Box::pin(async move {
            let update = match event {
                ConversationEvent::Started { conversation_id } => {
                    self.conversation.replace(Some(conversation_id.to_owned()));
                    return Ok(());
                }
                ConversationEvent::AssistantDelta(text) => {
                    self.shown_text_bytes += text.len();
                    assistant_text(text)
                }
                ConversationEvent::AssistantText(text) => {
                    let shown = std::mem::take(&mut self.shown_text_bytes);
                    let remainder = text
                        .get(shown..)
                        .ok_or(CapabilityError("acp_text_mismatch"))?;
                    if remainder.is_empty() {
                        return Ok(());
                    }
                    assistant_text(remainder)
                }
                ConversationEvent::ToolPrepared { call_id, tool } => json!({
                    "sessionUpdate":"tool_call","toolCallId":call_id,"title":tool,"status":"pending"
                }),
                ConversationEvent::ToolSettled { call_id, status } => json!({
                    "sessionUpdate":"tool_call_update","toolCallId":call_id,
                    "status":if status == "success" { "completed" } else { "failed" },
                    "_meta":{"peer":{"evidenceRef":format!("tool-result://{call_id}")}}
                }),
            };
            self.connection
                .writer
                .send(&json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":self.session,"update":update
                }}))
                .await
                .map_err(|_| CapabilityError("acp_output_unavailable"))
        })
    }
}

fn assistant_text(text: &str) -> Value {
    json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}})
}
