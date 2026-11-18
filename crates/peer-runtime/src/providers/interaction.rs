//! The headless Host exposes the canonical question tool and settles its
//! local denial before ending the turn.
use super::*;

const ALIAS: &str = "request_user_input";
const CAPABILITY: &str = "local.interaction.request_user_input";
pub(crate) const UNAVAILABLE: &str = "request_user_input_unavailable";

pub(super) struct UnavailableInputProvider;

impl CapabilityProvider for UnavailableInputProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        let manifest = json!({
            "capabilityId": CAPABILITY,
            "displayName": "Request user input",
            "description": "Ask the user a question and end the current turn. This host cannot wait for an answer. Put the question and optional choices in the arguments.",
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
        Ok(Box::new(UserInput(args)))
    }
}

struct UserInput(Value);

impl PreparedEffect for UserInput {
    fn args(&self) -> &Value {
        &self.0
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
        Err(HostError(UNAVAILABLE))
    }
}
