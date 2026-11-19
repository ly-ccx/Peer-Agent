//! One native turn ordering for Goal, ordinary conversation, headless and ACP
//! Hosts. Visibility, grants, durable facts and real completion belong to Hosts.
use crate::{
    CancellationToken,
    capability::CapabilityError,
    model::{ModelContinuation, ModelToolCall, ModelTurn},
};

pub(crate) trait TurnHost {
    /// Prepare/send through the actual model/Context seam and capture usage,
    /// including errors. Revalidate the live principal before returning calls.
    async fn request(&mut self) -> Result<ModelTurn, CapabilityError>;
    async fn record_assistant(&mut self, turn: &ModelTurn) -> Result<(), CapabilityError>;
    /// Return only after the Host has settled the grant, result and Evidence.
    /// Unknown effects remain errors.
    async fn execute_call(&mut self, call: ModelToolCall) -> Result<ToolStep, CapabilityError>;
    /// Bind authentic provider continuation to the committed canonical history.
    async fn completed(
        &mut self,
        continuation: Option<ModelContinuation>,
        ids: &[String],
    ) -> Result<(), CapabilityError>;
}

pub(crate) enum ToolStep {
    Continue(String),
    UserInputUnavailable,
    RequestedUserInput,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LoopStop {
    Replied,
    UserInputUnavailable,
    RequestedUserInput,
    MaxTurns,
}
impl LoopStop {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Replied => "replied",
            Self::UserInputUnavailable => crate::providers::interaction::UNAVAILABLE,
            Self::RequestedUserInput => "requested_user_input",
            Self::MaxTurns => "max_turns",
        }
    }
}
pub(crate) struct LoopOutcome {
    pub stop: LoopStop,
    pub content: String,
    pub tool_calls: usize,
}
fn current(owned: &CancellationToken, external: &CancellationToken) -> Result<(), CapabilityError> {
    if owned.is_cancelled() || external.is_cancelled() {
        Err(CapabilityError("CANCELLED"))
    } else {
        Ok(())
    }
}
pub(crate) async fn run(
    host: &mut impl TurnHost,
    max_turns: Option<usize>,
    owned: &CancellationToken,
    external: &CancellationToken,
) -> Result<LoopOutcome, CapabilityError> {
    if max_turns == Some(0) {
        return Err(CapabilityError("invalid_max_turns"));
    }
    let mut turns = 0usize;
    let mut tool_calls = 0usize;
    let mut content = String::new();
    while max_turns.is_none_or(|limit| turns < limit) {
        current(owned, external)?;
        let mut turn = host.request().await?;
        current(owned, external)?;
        turns = turns
            .checked_add(1)
            .ok_or(CapabilityError("runtime_counter_limit"))?;
        if !turn.content.is_empty() || !turn.thinking.is_empty() {
            host.record_assistant(&turn).await?;
            content = std::mem::take(&mut turn.content);
        }
        if turn.calls.is_empty() {
            return Ok(LoopOutcome {
                stop: LoopStop::Replied,
                content,
                tool_calls,
            });
        }
        let mut ids = Vec::with_capacity(turn.calls.len());
        for call in std::mem::take(&mut turn.calls) {
            current(owned, external)?;
            let step = host.execute_call(call).await?;
            tool_calls = tool_calls
                .checked_add(1)
                .ok_or(CapabilityError("runtime_counter_limit"))?;
            match step {
                ToolStep::Continue(id) => ids.push(id),
                ToolStep::UserInputUnavailable => {
                    return Ok(LoopOutcome {
                        stop: LoopStop::UserInputUnavailable,
                        content,
                        tool_calls,
                    });
                }
                ToolStep::RequestedUserInput => {
                    return Ok(LoopOutcome {
                        stop: LoopStop::RequestedUserInput,
                        content,
                        tool_calls,
                    });
                }
            }
        }
        host.completed(turn.continuation, &ids).await?;
    }
    Ok(LoopOutcome {
        stop: LoopStop::MaxTurns,
        content,
        tool_calls,
    })
}

pub(crate) fn apply_assistant_thinking(record: &mut serde_json::Value, turn: &ModelTurn) {
    if turn.thinking.is_empty() {
        return;
    }
    let mut segments = vec![serde_json::json!({
        "type": "thinking",
        "content": turn.thinking,
    })];
    if !turn.content.is_empty() {
        segments.push(serde_json::json!({
            "type": "text",
            "content": turn.content,
        }));
    }
    record["thinkingContent"] = serde_json::json!(turn.thinking);
    record["segments"] = serde_json::Value::Array(segments);
}

#[cfg(test)]
mod tests;
