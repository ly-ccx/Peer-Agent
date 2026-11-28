use super::*;
use peer_protocol::{
    MAX_CHECK_CHARS, MAX_INVARIANT_CHARS, MAX_NOTE_CHARS, MAX_SUMMARY_CHARS, MAX_TITLE_CHARS,
    MAX_WORKING_PLAN_INVARIANTS, MAX_WORKING_PLAN_STEPS, WORKING_PLAN_CAPABILITY,
    WORKING_PLAN_TOOL_NAME, WorkingPlanInput, validate_and_normalize_working_plan,
};
use peer_store::WorkingPlanStore;

pub(crate) struct PlanProvider {
    epoch: u64,
}

impl PlanProvider {
    pub(crate) fn new(epoch: u64) -> Self {
        Self { epoch }
    }
}

impl CapabilityProvider for PlanProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        vec![(
            WORKING_PLAN_TOOL_NAME.into(),
            json!({
                "capabilityId": WORKING_PLAN_CAPABILITY,
                "displayName": "Update working plan",
                "riskLevel": "L0_inert",
                "modeScopes": ["chat", "goal"],
                "description": "Record or replace the current session's lightweight working plan (ordered steps, optional per-step verification check, and invariants to preserve). Use for multi-step or cross-file tasks before editing and update as steps progress; unnecessary for trivial 1-3 turn lookups. At most one step may be in_progress. Does not replace real tool execution or verification evidence.",
                "inputSchema": {
                    "type": "object",
                    "required": ["steps"],
                    "additionalProperties": false,
                    "properties": {
                        "summary": {"type": "string", "maxLength": MAX_SUMMARY_CHARS},
                        "invariants": {
                            "type": "array",
                            "maxItems": MAX_WORKING_PLAN_INVARIANTS,
                            "items": {"type": "string", "maxLength": MAX_INVARIANT_CHARS},
                        },
                        "steps": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": MAX_WORKING_PLAN_STEPS,
                            "items": {
                                "type": "object",
                                "required": ["title", "status"],
                                "additionalProperties": false,
                                "properties": {
                                    "title": {"type": "string", "maxLength": MAX_TITLE_CHARS},
                                    "status": {"type": "string", "enum": ["pending", "in_progress", "completed", "blocked"]},
                                    "check": {"type": "string", "maxLength": MAX_CHECK_CHARS},
                                    "note": {"type": "string", "maxLength": MAX_NOTE_CHARS},
                                },
                            },
                        },
                    },
                },
            }),
        )]
    }

    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        _: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if capability != WORKING_PLAN_CAPABILITY {
            return Err(HostError("tool_not_projected"));
        }
        let parsed = serde_json::from_value(args.clone())
            .map_err(|_| HostError("tool_arguments_invalid"))?;
        let input = validate_and_normalize_working_plan(parsed).map_err(HostError)?;
        Ok(Box::new(UpdatePlanEffect {
            args,
            input,
            epoch: self.epoch,
            home: home.into(),
            admission: None,
        }))
    }
}

struct UpdatePlanEffect {
    args: Value,
    input: WorkingPlanInput,
    epoch: u64,
    home: PathBuf,
    admission: Option<EffectAdmission>,
}

impl PreparedEffect for UpdatePlanEffect {
    fn admission(&mut self, port: EffectAdmission) {
        self.admission = Some(port);
    }

    fn args(&self) -> &Value {
        &self.args
    }

    fn permission(&self) -> ProviderPermission {
        ProviderPermission::WorkingPlan
    }

    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }

    fn start(
        mut self: Box<Self>,
        call: ProviderCall,
        cancel: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        let port = self
            .admission
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        Ok(Box::pin(async move {
            if let Err(error) = port.check().await {
                return EffectOutcome::not_dispatched(error.0);
            }
            if cancel.is_cancelled() {
                return EffectOutcome::not_dispatched("CANCELLED");
            }
            let saved = tokio::task::spawn_blocking(move || {
                if cancel.is_cancelled() {
                    return Err(HostError("CANCELLED"));
                }
                WorkingPlanStore::new(&self.home)
                    .upsert(
                        call.conversation_id(),
                        self.epoch,
                        self.input,
                        call.started_at(),
                    )
                    .map_err(HostError::from)
            })
            .await;
            match saved {
                Ok(Ok(snapshot)) => {
                    let (completed, total, blocked) = snapshot.counts();
                    EffectOutcome {
                        status: "success",
                        output: json!({
                            "ok": true,
                            "epoch": snapshot.epoch,
                            "revision": snapshot.revision,
                            "completed": completed,
                            "total": total,
                            "blocked": blocked,
                            "inProgress": snapshot.in_progress_step().map(|step| step.title.as_str()),
                        }),
                        error: None,
                        artifacts: vec![],
                        ended: true,
                        materialization: None,
                        not_dispatched: false,
                    }
                }
                Ok(Err(error)) => EffectOutcome::not_dispatched(error.0),
                Err(_) => EffectOutcome::failed("working_plan_write_failed"),
            }
        }))
    }
}
