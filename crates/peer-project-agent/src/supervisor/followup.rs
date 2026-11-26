use super::*;

#[derive(Debug, Clone)]
pub struct MessageSessionRequest<'a> {
    pub workspace_id: &'a str,
    pub session_id: &'a str,
    pub text: &'a str,
    pub intent: &'a str,
    pub expected_epoch: Option<u64>,
    pub anchor_message_ids: Vec<String>,
    pub worker_model_selection: Option<Value>,
    pub holds_lease: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSessionOutcome {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub predecessor_session_id: Option<String>,
    pub delivery: &'static str,
    pub follow_up_epoch: u64,
    pub conversation_id: String,
    pub status: String,
    pub summary: WorkSessionSummary,
}

fn outcome(
    summary: WorkSessionSummary,
    delivery: &'static str,
    predecessor_session_id: Option<String>,
) -> MessageSessionOutcome {
    MessageSessionOutcome {
        session_id: summary.session_id.clone(),
        predecessor_session_id,
        delivery,
        follow_up_epoch: summary.follow_up_epoch.unwrap_or(0),
        conversation_id: summary.conversation_id.clone(),
        status: summary.status.clone(),
        summary,
    }
}

fn model_matches(selection: Option<&Value>, attribution: &Value) -> bool {
    let Some(selection) = selection else {
        return true;
    };
    let model = selection["modelId"].as_str();
    let provider = selection["providerName"]
        .as_str()
        .or_else(|| selection["family"].as_str())
        .or_else(|| selection["provider"].as_str());
    model.is_none_or(|id| attribution["model"] == id)
        && provider.is_none_or(|name| attribution["providerName"] == name)
}

fn reusable_workspace(plan: &Value) -> bool {
    if plan["deliveryBinding"]["executionIsolation"] != "worktree" {
        return plan["targetWorkspacePath"]
            .as_str()
            .or_else(|| plan["originWorkspacePath"].as_str())
            .is_some_and(|path| Path::new(path).is_dir());
    }
    plan["deliveryHandoff"]["status"] != "merged"
        && plan["deliveryBinding"]["worktreePath"]
            .as_str()
            .is_some_and(|path| Path::new(path).is_dir())
}

fn queue(plan: &mut Value, at: &str) {
    plan["status"] = json!("running");
    plan["delegationOrigin"]["phase"] = json!("queued");
    plan["delegationOrigin"]["agentWaitMessageId"] = Value::Null;
    plan["delegationOrigin"]["agentWaitQuestion"] = Value::Null;
    plan["runner"]["status"] = json!("running");
    plan["runner"]["waitingOnUser"] = Value::Null;
    plan["runner"]["blockedReason"] = Value::Null;
    plan["runner"]["interruption"] = Value::Null;
    plan["updatedAt"] = json!(at);
}

impl SessionSupervisor {
    // Retain a journaled input across a retry that follows an uncertain plan write.
    fn append_session_input(
        &self,
        conversation: &str,
        mut message: Value,
    ) -> Result<(), ProjectError> {
        let at = message["createdAt"].as_str().unwrap_or_default().to_owned();
        let rows = crate::read_full_conversation_messages(&self.conversations, conversation)?;
        if let Some(existing) = rows.iter().find(|row| row["id"] == message["id"]) {
            message["createdAt"] = existing["createdAt"].clone();
            if *existing != message {
                return Err(ProjectError::code("session_input_conflict"));
            }
            return Ok(());
        }
        self.conversations
            .append_message_idempotent(conversation, &message, &at, None)?;
        Ok(())
    }

    pub fn message_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        text: &str,
        intent: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        self.message_session_full(MessageSessionRequest {
            workspace_id,
            session_id,
            text,
            intent,
            expected_epoch: None,
            anchor_message_ids: Vec::new(),
            worker_model_selection: None,
            holds_lease,
        })
        .map(|sent| sent.summary)
    }

    pub fn message_session_full(
        &self,
        req: MessageSessionRequest<'_>,
    ) -> Result<MessageSessionOutcome, ProjectError> {
        self.deliver_session_message(req, None, &[])
    }

    pub(crate) fn deliver_session_message(
        &self,
        req: MessageSessionRequest<'_>,
        parent: Option<(&str, bool)>,
        attachments: &[Value],
    ) -> Result<MessageSessionOutcome, ProjectError> {
        if !req.holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let text = req.text.trim();
        if !matches!(req.intent, "answer" | "amend" | "followup")
            || text.is_empty()
            || text.chars().count() > 8_000
        {
            return Err(ProjectError::code("invalid_input"));
        }
        let _transition = self.transition_lock()?;
        let mut plan = if let Some((parent_id, _)) = parent {
            self.plan_for_bot(req.workspace_id, parent_id, req.session_id)?
        } else {
            self.find_plan_by_session(req.workspace_id, req.session_id)
                .ok_or_else(|| ProjectError::code("NOT_FOUND"))?
        };
        if let Some(successor) = plan["delegationOrigin"]["supersededBy"].as_str() {
            return Err(ProjectError::new(
                "session_superseded",
                format!("supersededBy={successor}"),
            ));
        }
        let status = if plan["status"] == "interrupted" {
            "interrupted".to_owned()
        } else {
            derive_session_status(&plan)
        };
        if status == "cancelled" {
            return Err(ProjectError::code("session_cancelled"));
        }
        let epoch = plan["delegationOrigin"]["followUpEpoch"]
            .as_u64()
            .unwrap_or(0);
        if req.expected_epoch.is_some_and(|expected| expected != epoch) {
            return Err(ProjectError::new(
                "follow_up_claimed",
                format!("followUpEpoch={epoch}"),
            ));
        }
        if matches!(
            status.as_str(),
            "stopping" | "awaiting_outcome" | "verifying"
        ) || matches!(
            plan["runner"]["blockedReason"].as_str(),
            Some(
                "execution_outcome_unknown"
                    | "cancelled_outcome_unknown"
                    | "coordination_reconciliation_required"
                    | "conversation_persistence_failed"
            )
        ) {
            return Err(ProjectError::code("session_busy_settling"));
        }
        let autonomous = parent.is_some_and(|(_, wake)| wake);
        let is_terminal = matches!(
            status.as_str(),
            "result_ready" | "accepted" | "failed" | "interrupted"
        ) || (status == "paused"
            && plan["runner"]["interruption"]["recoverable"] == true);
        if autonomous && req.intent != "answer" && (!is_terminal || status == "accepted") {
            return Err(ProjectError::code("current_user_required"));
        }
        if is_terminal {
            if req.intent == "answer" {
                return Err(ProjectError::code("session_not_waiting_answer"));
            }
            if autonomous {
                if plan["delegationOrigin"]["terminalEvent"]["payload"]["stopAutoRetry"] == true {
                    return Err(ProjectError::code("same_cause_retry_limit"));
                }
                self.check_recovery_gates(&plan)?;
            }
            return self.follow_up_finished_session(req, plan, &status, epoch, attachments);
        }
        let is_waiting = matches!(status.as_str(), "waiting_user" | "waiting_agent");
        if req.intent == "answer" && !is_waiting {
            return Err(ProjectError::code("no_pending_question"));
        }
        if status == "waiting_agent" && req.intent == "answer" {
            self.check_recovery_gates(&plan)?;
            let summary = self.answer_worker_locked(&mut plan, text, attachments)?;
            return Ok(outcome(summary, "answered", None));
        }
        if autonomous {
            return Err(ProjectError::code("current_user_required"));
        }
        if status == "waiting_user" && plan["runner"]["status"] != "waiting_user" {
            // Planning approval, budget recovery and result acceptance have their own host gates.
            return Err(ProjectError::code("current_user_required"));
        }
        if !matches!(
            status.as_str(),
            "waiting_user" | "waiting_agent" | "queued" | "starting" | "running" | "paused"
        ) {
            return Err(ProjectError::code("session_not_messageable"));
        }
        let conv_id = plan["conversationId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?
            .to_owned();
        let seq = plan["delegationOrigin"]["pendingSteerSeq"]
            .as_u64()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| ProjectError::code("session_message_limit"))?;
        let at = now_iso();
        let answered = req.intent == "answer";
        self.append_session_input(
            &conv_id,
            json!({
                "id": format!("worker-input-{conv_id}-{seq}"), "role": "user",
                "kind": if answered { "user_input" } else { "user_correction" },
                "content": text, "followUpEpoch": epoch, "steerSeq": seq,
                "attachments": attachments, "createdAt": at,
            }),
        )?;
        if is_waiting || status == "paused" {
            if self.load_worker_checkpoint(&plan)?.is_some() {
                plan["delegationOrigin"]["continueWorkerConversation"] = json!(true);
            }
            queue(&mut plan, &at);
        }
        plan["delegationOrigin"]["pendingSteerSeq"] = json!(seq);
        plan["delegationOrigin"]["pendingSteerEpoch"] = json!(epoch);
        plan["updatedAt"] = json!(at);
        self.write_plan(&plan)?;
        Ok(outcome(
            self.summarize(&plan),
            if answered { "answered" } else { "steered" },
            None,
        ))
    }

    fn follow_up_finished_session(
        &self,
        req: MessageSessionRequest<'_>,
        mut plan: Value,
        status: &str,
        epoch: u64,
        attachments: &[Value],
    ) -> Result<MessageSessionOutcome, ProjectError> {
        let at = now_iso();
        let text = req.text.trim();
        let mut anchors = self.summarize(&plan).anchor_message_ids;
        for anchor in req.anchor_message_ids {
            if !anchors.contains(&anchor) {
                anchors.push(anchor);
            }
        }
        if let Ok(Some(checkpoint)) = self.load_worker_checkpoint(&plan)
            && reusable_workspace(&plan)
            && model_matches(req.worker_model_selection.as_ref(), &checkpoint.attribution)
        {
            let next_epoch = epoch
                .checked_add(1)
                .ok_or_else(|| ProjectError::code("session_message_limit"))?;
            let conv_id = &checkpoint.identity.conversation_id;
            let id = format!("worker-followup-{}-{next_epoch}", req.session_id);
            self.append_session_input(
                conv_id,
                json!({
                    "id": id, "role": "user", "kind": "user_followup",
                    "content": text, "followUpEpoch": next_epoch, "attachments": attachments,
                    "createdAt": at,
                }),
            )?;
            let previous = json!({
                "epoch": epoch,
                "previousStatus": status,
                "archivedAt": at,
                "workerOutputPreview": plan["delegationOrigin"]["lastWorkerOutput"].as_str()
                    .unwrap_or_default().chars().take(1000).collect::<String>(),
                "resultRevision": plan["updatedAt"],
                "resultAcceptance": plan["resultAcceptance"],
                "manualConfirmations": plan["manualConfirmations"],
                "verificationReport": plan["verificationReport"],
                "failure": plan["failure"],
            });
            let origin = &mut plan["delegationOrigin"];
            let mut history = origin["followUpHistory"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            history.push(previous);
            history.drain(..history.len().saturating_sub(16));
            origin["followUpHistory"] = json!(history);
            origin["followUpEpoch"] = json!(next_epoch);
            origin["continueWorkerConversation"] = json!(true);
            origin["followUpPrompt"] = json!(text);
            origin["anchorMessageIds"] = json!(anchors);
            origin["executionGeneration"] = json!(uuid::Uuid::new_v4().to_string());
            origin["workerTurnsUsed"] = json!(0);
            origin["error"] = Value::Null;
            origin["errorDetail"] = Value::Null;
            origin["independentVerifier"] = Value::Null;
            plan["resultAcceptance"] = Value::Null;
            plan["manualConfirmations"] = Value::Null;
            plan["modelReviews"] = Value::Null;
            plan["criterionResults"] = Value::Null;
            plan["failure"] = Value::Null;
            plan["verificationReport"] = Value::Null;
            plan["modelReviewSourceRevision"] = Value::Null;
            queue(&mut plan, &at);
            self.write_plan(&plan)?;
            self.emit_event(
                req.workspace_id,
                "session_resumed",
                req.session_id,
                json!({
                    "planId": plan["planId"], "followUpEpoch": next_epoch,
                }),
            );
            return Ok(outcome(self.summarize(&plan), "resumed_followup", None));
        }

        let origin = &plan["delegationOrigin"];
        let title = plan["title"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
        let prior: String = origin["lastWorkerOutput"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(2000)
            .collect();
        let brief = format!(
            "[Follow-up to prior task \"{title}\" (session {}, status={status})]\nPrior outcome summary:\n{prior}\n\nNew follow-up instruction:\n{text}",
            req.session_id
        );
        let successor = self.spawn_session_impl(
            SpawnSessionRequest {
                workspace_id: req.workspace_id.to_owned(),
                workspace_path: plan["originWorkspacePath"]
                    .as_str()
                    .map(PathBuf::from)
                    .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?,
                parent_conversation_id: origin["parentConversationId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                anchor_message_ids: anchors,
                input_id: origin["inputId"].as_str().unwrap_or_default().to_owned(),
                surface: origin["surface"].as_str().unwrap_or("tui").to_owned(),
                title: title.to_owned(),
                brief,
                kind: origin["kind"].as_str().unwrap_or("other").to_owned(),
                read_only: origin["readOnly"] == true,
                required_capabilities: serde_json::from_value(
                    origin["requiredCapabilities"].clone(),
                )
                .unwrap_or_default(),
                success_criteria: serde_json::from_value(plan["successCriteria"].clone())
                    .map_err(|_| ProjectError::code("INVALID_PLAN"))?,
                priority: origin["priority"].as_str().unwrap_or("normal").to_owned(),
                depends_on: serde_json::from_value(origin["dependsOn"].clone()).unwrap_or_default(),
                supersedes: Some(req.session_id.to_owned()),
                objective_id: origin["objectiveId"].as_str().map(str::to_owned),
                isolation: plan["deliveryBinding"]["executionIsolation"]
                    .as_str()
                    .or_else(|| origin["isolation"].as_str())
                    .unwrap_or("none")
                    .to_owned(),
                worker_model_selection: req
                    .worker_model_selection
                    .unwrap_or_else(|| origin["modelSelection"]["worker"].clone()),
            },
            None,
            Some(attachments),
        )?;
        self.retire_replaced_session(&mut plan, &json!(successor.session_id))?;
        Ok(outcome(
            successor,
            "started_fresh",
            Some(req.session_id.to_owned()),
        ))
    }
}
