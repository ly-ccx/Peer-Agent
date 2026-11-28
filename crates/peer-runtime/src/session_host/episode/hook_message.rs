//! The original Work tool intent and Provider observation share one canonical
//! Conversation message. A Post Hook can add observations to its Evidence.
use super::*;
use peer_protocol::WorkHookIntent;

pub(in crate::session_host) struct HookMessage<'a> {
    pub intent: &'a WorkHookIntent,
    pub conversation: &'a str,
    pub stream: &'a str,
    pub call: &'a str,
    pub tool: &'a str,
    pub args: &'a Value,
}

impl HookMessage<'_> {
    pub fn publish(&self, host: &NativeSessionHost) -> Result<(), HostError> {
        host.append_episode_message(
            self.conversation,
            &json!({
                "id": self.intent.message_id,"role":"assistant","content":"","createdAt":now(),
                "streamId":self.stream,"segments":[{
                    "type":"tool-call","tool":self.tool,"toolCallId":self.call,"args":self.args
                }], "permissionGrants":[]
            }),
        )
    }

    pub fn commit(
        &self,
        host: &NativeSessionHost,
        grants: &[Value],
        result: Option<&Value>,
    ) -> Result<(), HostError> {
        let store = ConversationStore::new(&host.home);
        let expected = store.read_committed(self.conversation, None, 8 * 1024 * 1024)?;
        let error = HostError("native_hook_tool_intent_changed");
        let message = expected
            .history
            .messages
            .iter()
            .find(|row| row["id"] == self.intent.message_id)
            .ok_or(error)?;
        let old = message["segments"]
            .as_array()
            .filter(|segments| segments.len() == 1)
            .map(|segments| &segments[0])
            .ok_or(error)?;
        if message["role"] != "assistant"
            || message["streamId"] != self.stream
            || old["type"] != "tool-call"
            || old["tool"] != self.tool
            || old["toolCallId"] != self.call
            || old["args"] != *self.args
            || peer_protocol::approval_args_digest(&old["args"])
                .ok()
                .as_ref()
                != Some(&self.intent.args_digest)
            || message["permissionGrants"]
                .as_array()
                .is_none_or(|previous| !grants.starts_with(previous))
        {
            return Err(error);
        }
        if let Some(previous) = old.get("result") {
            fn provider_observation(result: &Value) -> Value {
                let mut copy = result.clone();
                if let Some(evidence) = copy["evidence"].as_object_mut() {
                    evidence.remove("hooks");
                    evidence.remove("hookFinalDecision");
                }
                copy
            }
            if result.is_none_or(|new| provider_observation(new) != provider_observation(previous))
            {
                return Err(error);
            }
        }
        let mut segment = old.clone();
        if let Some(result) = result {
            segment["result"] = result.clone();
        }
        store.commit_terminal_message(
            &expected,
            &self.intent.message_id,
            &json!({"segments":[segment],"permissionGrants":grants}),
            &now(),
            None,
        )?;
        Ok(())
    }
}
