//! The Host exposes the canonical question tool (`request_user_input`).
//! Interactive UI Hosts self-grant and surface the question+options before stopping the turn;
//! headless Hosts settle a local denial and end the turn.
use super::*;

const ALIAS: &str = "request_user_input";
const CAPABILITY: &str = "local.interaction.request_user_input";
pub(crate) const UNAVAILABLE: &str = "request_user_input_unavailable";
pub(crate) const SELF_GRANT_REASON: &str = "interaction_self_grant";

pub(super) struct InteractionProvider {
    interactive: bool,
}

impl InteractionProvider {
    pub(super) fn new(interactive: bool) -> Self {
        Self { interactive }
    }
}

impl CapabilityProvider for InteractionProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        let description = if self.interactive {
            "Ask the user a question and stop the current turn to wait for their reply. Call this whenever you need a decision, clarification, approval, or a choice from the user (for example: \"commit as 1, 2, or 3?\"). Do NOT keep running other tools or make the choice on the user's behalf in the same turn — calling this tool ends your turn and returns control to the user. Put the actual question (and any options) in the arguments so the user sees it."
        } else {
            "Ask the user a question and end the current turn. This host cannot wait for an answer. Put the question and optional choices in the arguments."
        };
        let manifest = json!({
            "capabilityId": CAPABILITY,
            "displayName": "Request user input",
            "description": description,
            "riskLevel": "L0_inert",
            "modeScopes": ["chat", "plan", "goal"],
            "inputSchema": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question to ask the user. Required and must be non-empty."
                    },
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of discrete choices the user can pick from (e.g. [\"1\", \"2\", \"3\"])."
                    }
                },
                "required": ["question"],
                "additionalProperties": false
            }
        });
        vec![(ALIAS.into(), manifest)]
    }

    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        _: &Path,
        _: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if capability != CAPABILITY {
            return Err(HostError("tool_not_projected"));
        }
        validate_shape(&args, &["question", "options"])?;
        if !args["question"]
            .as_str()
            .is_some_and(|question| !peer_protocol::javascript_trim(question).is_empty())
            || args.get("options").is_some_and(|options| {
                !options
                    .as_array()
                    .is_some_and(|choices| choices.iter().all(Value::is_string))
            })
        {
            return Err(HostError("tool_arguments_invalid"));
        }
        Ok(Box::new(UserInput {
            args,
            interactive: self.interactive,
        }))
    }
}

struct UserInput {
    args: Value,
    interactive: bool,
}

impl PreparedEffect for UserInput {
    fn args(&self) -> &Value {
        &self.args
    }

    fn permission(&self) -> ProviderPermission {
        ProviderPermission::UserInput
    }

    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }

    fn start(
        self: Box<Self>,
        _: ProviderCall,
        _: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        if !self.interactive {
            return Err(HostError(UNAVAILABLE));
        }
        let question = self.args["question"]
            .as_str()
            .map(peer_protocol::javascript_trim)
            .unwrap_or("")
            .to_owned();
        let options: Vec<String> = self.args["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .map(|s| peer_protocol::javascript_trim(s).to_owned())
            .filter(|s| !s.is_empty())
            .collect();
        Ok(Box::pin(async move {
            EffectOutcome {
                status: "success",
                output: json!({
                    "ok": true,
                    "acknowledged": true,
                    "question": question,
                    "options": options,
                    "note": "Question surfaced to the user. The turn stops here and waits for the user to reply.",
                    "control": {
                        "terminal": true,
                        "reason": "request_user_input"
                    }
                }),
                error: None,
                artifacts: vec![],
                ended: true,
                materialization: None,
                not_dispatched: false,
            }
        }))
    }
}
