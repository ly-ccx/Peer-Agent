//! A model may propose an Explorer request. The Runner owns admission and scope.
use super::*;
use serde::{Deserialize, Serialize};

pub(crate) const CAPABILITY: &str = "local.goal.explore";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExplorerRequest {
    pub question: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub scope: ExplorerHints,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct ExplorerHints {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}

impl ExplorerRequest {
    pub(crate) fn parse(args: &Value) -> Result<Self, HostError> {
        let invalid = HostError("explorer_request_invalid");
        if serde_json::to_vec(args).map_err(|_| invalid)?.len() > 32 * 1024 {
            return Err(invalid);
        }
        let mut request: Self = serde_json::from_value(args.clone()).map_err(|_| invalid)?;
        request.question = javascript_trim(&request.question).to_owned();
        request.reason = javascript_trim(&request.reason).to_owned();
        if request.question.is_empty()
            || request.question.len() > 4096
            || request.reason.len() > 4096
        {
            return Err(invalid);
        }
        for hints in [&mut request.scope.include, &mut request.scope.exclude] {
            if hints.len() > 12 || hints.iter().any(|hint| hint.len() > 1024) {
                return Err(invalid);
            }
            hints.retain_mut(|hint| {
                *hint = javascript_trim(hint).to_owned();
                !hint.is_empty()
            });
        }
        Ok(request)
    }
}

pub(super) struct RegisterExplorer {
    args: Value,
    request: Result<ExplorerRequest, HostError>,
    admission: Option<EffectAdmission>,
}

impl RegisterExplorer {
    pub(super) fn prepare(args: Value) -> Box<dyn PreparedEffect> {
        let request = ExplorerRequest::parse(&args);
        Box::new(Self {
            args,
            request,
            admission: None,
        })
    }
}

impl PreparedEffect for RegisterExplorer {
    fn admission(&mut self, port: EffectAdmission) {
        self.admission = Some(port);
    }

    fn args(&self) -> &Value {
        &self.args
    }

    fn permission(&self) -> ProviderPermission {
        ProviderPermission::ConversationGoal
    }

    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(Vec::new())
    }

    fn start(
        mut self: Box<Self>,
        _: ProviderCall,
        _: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        let port = self
            .admission
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        let request = self.request;
        Ok(Box::pin(async move {
            if let Err(error) = port.check().await {
                return EffectOutcome::not_dispatched(error.0);
            }
            let request = match request {
                Ok(request) => request,
                Err(error) => return EffectOutcome::not_dispatched(error.0),
            };
            EffectOutcome {
                status: "success",
                output: json!({"ok":true,"registered":true,"question":request.question,
                    "reason":request.reason,"scope":request.scope}),
                error: None,
                artifacts: Vec::new(),
                ended: true,
                materialization: None,
                not_dispatched: false,
            }
        }))
    }
}
