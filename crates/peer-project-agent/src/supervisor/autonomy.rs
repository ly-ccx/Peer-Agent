//! Admission for wake actions against the existing, host-owned delegated plan.
use super::*;

pub(crate) const MAX_AUTONOMOUS_RETRIES: u64 = 2;
const MAX_AUTONOMOUS_RESUMES: u64 = 2;

pub(super) fn transient_worker_error(code: &str) -> bool {
    matches!(
        code,
        "model_timeout" | "model_transport_failed" | "model_stream_interrupted"
    )
}

fn verification_failed(plan: &Value) -> bool {
    plan["delegationOrigin"]["independentVerifier"] == "failed"
        || plan["verificationReport"]["passed"] == false
}

fn waiting_parent(plan: &Value) -> bool {
    derive_session_status(plan) == "waiting_agent"
        && (plan["delegationOrigin"]["agentWaitMessageId"].is_string()
            || plan["runner"]["blockedReason"] == "waiting_parent_agent")
        && plan["runner"]["status"] != "waiting_user"
}

impl SessionSupervisor {
    pub(super) fn transition_lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, ProjectError> {
        self.transitions
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))
    }

    pub(crate) fn plan_for_bot(
        &self,
        workspace_id: &str,
        parent_id: &str,
        session_id: &str,
    ) -> Result<Value, ProjectError> {
        self.find_plan_by_session(workspace_id, session_id)
            .filter(|p| p["delegationOrigin"]["parentConversationId"] == parent_id)
            .ok_or_else(|| ProjectError::code("out_of_scope"))
    }

    fn check_recovery_gates(&self, plan: &Value) -> Result<(), ProjectError> {
        let origin = &plan["delegationOrigin"];
        let runner = &plan["runner"];
        if origin["supersededBy"].is_string()
            || origin["cancellation"].is_object()
            || origin["takeover"].is_object()
            || runner["waitingOnUser"] == true
            || matches!(
                runner["status"].as_str(),
                Some("waiting_user" | "budget_exhausted")
            )
            || matches!(
                runner["blockedReason"].as_str(),
                Some(
                    "manual_dod_confirmation_required"
                        | "conversation_persistence_failed"
                        | "execution_outcome_unknown"
                        | "cancelled_outcome_unknown"
                        | "coordination_reconciliation_required"
                )
            )
            || matches!(
                derive_session_status(plan).as_str(),
                "accepted"
                    | "cancelled"
                    | "waiting_user"
                    | "stopping"
                    | "awaiting_outcome"
                    | "verifying"
            )
        {
            return Err(ProjectError::code("current_user_required"));
        }
        if origin["workerTurnLimit"]
            .as_u64()
            .is_some_and(|limit| origin["workerTurnsUsed"].as_u64().unwrap_or(0) >= limit)
        {
            return Err(ProjectError::code("worker_budget_exhausted"));
        }
        let workspace = origin["workspaceId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
        if self
            .approvals
            .list(Some(workspace), None)?
            .iter()
            .any(|row| {
                (row["sessionId"] == origin["sessionId"] || row["planId"] == plan["planId"])
                    && row["state"] == "open"
            })
        {
            return Err(ProjectError::code("current_user_required"));
        }
        if let Some(id) = origin["objectiveId"].as_str() {
            let objective = ObjectiveStore::new(&self.data_home)
                .get(workspace, id)?
                .filter(|o| o.status == "active" && o.pending_confirmation != Some(true));
            if objective.is_none() {
                return Err(ProjectError::code("current_user_required"));
            }
        }
        Ok(())
    }

    pub(crate) fn retry_session(
        &self,
        state: &crate::provider::TurnExecutionState,
        old_sid: &str,
        args: &Value,
    ) -> Result<(WorkSessionSummary, u64), ProjectError> {
        if !state.holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let _transition = self.transition_lock()?;
        let mut old = self.plan_for_bot(&state.workspace_id, &state.conversation_id, old_sid)?;
        let origin = &old["delegationOrigin"];
        let old_sid = origin["sessionId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;

        // A crash after creating the replacement must not allow a second branch.
        if let Some(replacement) = self
            .list_workspace_plans(&state.workspace_id)
            .into_iter()
            .find(|p| p["delegationOrigin"]["supersedes"] == old_sid)
        {
            let count = replacement["delegationOrigin"]["autoRetryCount"]
                .as_u64()
                .unwrap_or_default();
            if origin["supersededBy"].is_null() && count > 0 {
                self.retire_replaced_session(
                    &mut old,
                    &replacement["delegationOrigin"]["sessionId"],
                )?;
            }
            return Err(ProjectError::code("session_already_superseded"));
        }
        self.check_recovery_gates(&old)?;
        let count = origin["autoRetryCount"]
            .as_u64()
            .unwrap_or_default()
            .saturating_add(1);
        if count > MAX_AUTONOMOUS_RETRIES {
            return Err(ProjectError::code("auto_retry_limit_exceeded"));
        }
        let status = derive_session_status(&old);
        let read_only = origin["readOnly"] == true;
        let failure = old["failure"]["code"]
            .as_str()
            .or_else(|| origin["error"].as_str())
            .unwrap_or("");
        let preflight_failure = status == "failed"
            && failure == "WORKER_MODEL_UNAVAILABLE"
            && origin["workerConversationId"].is_null()
            && origin["coordinationBinding"].is_null();
        let safe_read_retry = read_only
            && ((status == "failed"
                && (transient_worker_error(failure) || failure == "agent_loop_exhausted"))
                || (status == "result_ready" && verification_failed(&old)));
        if !preflight_failure && !safe_read_retry {
            return Err(ProjectError::code("session_not_retryable"));
        }
        if !origin["coordinationBinding"].is_null() {
            return Err(ProjectError::code("current_user_required"));
        }
        let isolation = old["deliveryBinding"]["executionIsolation"]
            .as_str()
            .unwrap_or("none");
        if args["isolation"] == "none" && isolation == "worktree" {
            return Err(ProjectError::code("retry_isolation_downgrade"));
        }
        if (read_only && args["readOnly"] == false)
            || args.get("requiredCapabilities").is_some()
            || args.get("capabilityPreset").is_some()
        {
            return Err(ProjectError::code("retry_capability_escalation"));
        }
        // A wake retry is an exact replay of the task specification. The model supplies
        // only the predecessor identity, so its brief cannot expand the user's mandate.
        if args
            .as_object()
            .is_none_or(|args| args.keys().any(|k| k != "supersedes"))
        {
            return Err(ProjectError::code("retry_scope_changed"));
        }
        let parent_messages =
            crate::read_full_conversation_messages(&self.conversations, &state.conversation_id)?;
        let anchors = self.summarize(&old).anchor_message_ids;
        if anchors.is_empty()
            || anchors.iter().any(|id| {
                !parent_messages.iter().any(|message| {
                    message["id"] == *id
                        && message["role"] == "user"
                        && message["kind"] == "user_input"
                })
            })
        {
            return Err(ProjectError::code("invalid_anchor"));
        }
        let workspace_path = old["originWorkspacePath"]
            .as_str()
            .map(PathBuf::from)
            .filter(|path| {
                fs::canonicalize(path)
                    .ok()
                    .zip(fs::canonicalize(&state.workspace_path).ok())
                    .is_some_and(|(old, current)| old == current)
            })
            .ok_or_else(|| ProjectError::code("out_of_scope"))?;
        let req = SpawnSessionRequest {
            workspace_id: state.workspace_id.clone(),
            workspace_path,
            parent_conversation_id: state.conversation_id.clone(),
            anchor_message_ids: anchors,
            input_id: origin["inputId"].as_str().unwrap_or_default().to_owned(),
            surface: origin["surface"].as_str().unwrap_or("tui").to_owned(),
            title: old["title"].as_str().unwrap_or_default().to_owned(),
            brief: old["goal"].as_str().unwrap_or_default().to_owned(),
            kind: origin["kind"].as_str().unwrap_or("other").to_owned(),
            read_only,
            required_capabilities: serde_json::from_value(origin["requiredCapabilities"].clone())
                .unwrap_or_default(),
            success_criteria: serde_json::from_value(old["successCriteria"].clone())
                .map_err(|_| ProjectError::code("INVALID_PLAN"))?,
            priority: origin["priority"].as_str().unwrap_or("normal").to_owned(),
            depends_on: serde_json::from_value(origin["dependsOn"].clone()).unwrap_or_default(),
            supersedes: Some(old_sid.to_owned()),
            objective_id: origin["objectiveId"].as_str().map(str::to_owned),
            isolation: origin["isolation"].as_str().unwrap_or(isolation).to_owned(),
            worker_model_selection: origin["modelSelection"]["worker"].clone(),
        };
        let summary = self.spawn_session_impl(req, Some((count, &old)))?;
        Ok((summary, count))
    }

    pub(super) fn retire_replaced_session(
        &self,
        old: &mut Value,
        new_id: &Value,
    ) -> Result<(), ProjectError> {
        let at = now_iso();
        old["delegationOrigin"]["supersededBy"] = new_id.clone();
        old["delegationOrigin"]["supersededAt"] = json!(at);
        if old["status"] != "completed" && old["status"] != "failed" {
            old["delegationOrigin"]["phase"] = json!("paused");
        }
        old["updatedAt"] = json!(at);
        self.write_plan(old)
    }

    pub(crate) fn resume_technical_session(
        &self,
        workspace_id: &str,
        parent_id: &str,
        session_id: &str,
    ) -> Result<WorkSessionSummary, ProjectError> {
        let _transition = self.transition_lock()?;
        let mut plan = self.plan_for_bot(workspace_id, parent_id, session_id)?;
        self.check_recovery_gates(&plan)?;
        let interruption = &plan["runner"]["interruption"];
        if !matches!(
            derive_session_status(&plan).as_str(),
            "paused" | "queued" | "waiting_agent"
        ) || waiting_parent(&plan)
            || interruption["recoverable"] != true
            || !matches!(interruption["origin"].as_str(), Some("provider" | "tool"))
            || self.load_worker_checkpoint(&plan)?.is_none()
        {
            return Err(ProjectError::code("current_user_required"));
        }
        let origin = &mut plan["delegationOrigin"];
        let count = origin["autoResumeCount"].as_u64().unwrap_or_default();
        if count >= MAX_AUTONOMOUS_RESUMES {
            return Err(ProjectError::code("auto_resume_limit_exceeded"));
        }
        origin["autoResumeCount"] = json!(count + 1);
        origin["continueWorkerConversation"] = json!(true);
        plan["runner"]["interruption"] = Value::Null;
        self.queue_continuation(&mut plan)?;
        Ok(self.summarize(&plan))
    }

    pub(crate) fn answer_worker(
        &self,
        workspace_id: &str,
        parent_id: &str,
        session_id: &str,
        text: &str,
    ) -> Result<WorkSessionSummary, ProjectError> {
        let _transition = self.transition_lock()?;
        let mut plan = self.plan_for_bot(workspace_id, parent_id, session_id)?;
        self.check_recovery_gates(&plan)?;
        if !waiting_parent(&plan) || plan["runner"]["interruption"].is_object() {
            return Err(ProjectError::code("current_user_required"));
        }
        if text.trim().is_empty() || text.chars().count() > 4000 {
            return Err(ProjectError::code("invalid_input"));
        }
        let origin = &plan["delegationOrigin"];
        let wait_id = origin["agentWaitMessageId"]
            .as_str()
            .or_else(|| plan["runner"]["runId"].as_str())
            .ok_or_else(|| ProjectError::code("agent_request_identity_missing"))?
            .to_owned();
        let conv_id = if let Some(continuation) = self.load_worker_checkpoint(&plan)? {
            plan["delegationOrigin"]["continueWorkerConversation"] = json!(true);
            continuation.identity.conversation_id
        } else {
            return Err(ProjectError::code("worker_checkpoint_unavailable"));
        };
        let at = now_iso();
        let answer_id = format!(
            "agent-answer-{}",
            sha256_json(&json!([session_id, wait_id]))
        );
        // If the answer was committed before the plan write, retain that exact reply
        // and finish the queued transition without appending a second answer.
        let existing = crate::read_full_conversation_messages(&self.conversations, &conv_id)?
            .into_iter()
            .find(|row| row["id"] == answer_id);
        if let Some(existing) = existing {
            if existing["kind"] != "agent_answer" || existing["replyTo"] != json!([wait_id]) {
                return Err(ProjectError::code("agent_answer_conflict"));
            }
        } else {
            self.conversations.append_message_idempotent(
                &conv_id,
                &json!({
                    "id": answer_id, "role": "user", "kind": "agent_answer", "replyTo": [wait_id],
                    "content": text, "createdAt": at,
                }),
                &at,
                None,
            )?;
        }
        plan["delegationOrigin"]["lastAnsweredAgentWaitMessageId"] = json!(wait_id);
        plan["delegationOrigin"]["agentWaitMessageId"] = Value::Null;
        plan["delegationOrigin"]["agentWaitQuestion"] = Value::Null;
        self.queue_continuation(&mut plan)?;
        Ok(self.summarize(&plan))
    }

    fn queue_continuation(&self, plan: &mut Value) -> Result<(), ProjectError> {
        plan["delegationOrigin"]["phase"] = json!("queued");
        plan["status"] = json!("accepted");
        plan["runner"]["status"] = json!("running");
        plan["runner"]["blockedReason"] = Value::Null;
        plan["updatedAt"] = json!(now_iso());
        self.write_plan(plan)
    }

    pub(super) fn load_worker_checkpoint(
        &self,
        plan: &Value,
    ) -> Result<Option<peer_protocol::ConversationExecution>, ProjectError> {
        if !plan["delegationOrigin"]["coordinationBinding"].is_null() {
            return Ok(None);
        }
        let Some(id) = plan["delegationOrigin"]["workerConversationId"].as_str() else {
            return Ok(None);
        };
        Ok(self
            .conversations
            .read_conversation_execution(id)?
            .filter(|run| {
                run.engine == "peer-native" && run.permits_new_run() && !run.unknown_usage
            }))
    }
}
