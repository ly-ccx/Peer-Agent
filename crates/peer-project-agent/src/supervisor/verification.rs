use super::*;
use crate::verifier::{VerifierOutcome, run_independent_verifier_with_interactive};

const MAX_VERIFIER_RUNS: usize = 3;
const VERIFIER_TIMEOUT: Duration = Duration::from_secs(300);

pub(super) struct ActiveVerification {
    workspace_id: String,
    run_id: String,
    cancel: CancellationToken,
}

pub(super) struct VerificationGuard<'a, F: Fn() -> bool> {
    supervisor: &'a SessionSupervisor,
    session_id: &'a str,
    plan_id: &'a str,
    run_id: String,
    cancel: CancellationToken,
    holds_lease: &'a F,
}

impl<F: Fn() -> bool> VerificationGuard<'_, F> {
    pub(super) fn token(&self) -> &CancellationToken {
        &self.cancel
    }
}

impl<F: Fn() -> bool> Drop for VerificationGuard<'_, F> {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Ok(mut active) = self.supervisor.verifying_sessions.lock()
            && active
                .get(self.session_id)
                .is_some_and(|entry| entry.run_id == self.run_id)
        {
            active.remove(self.session_id);
        }
        // Dropping can happen during unwinding or while another transition has the lock.
        // Maintenance retries any cleanup that could not acquire the lock or persist here.
        let _transition = match self.supervisor.transitions.try_lock() {
            Ok(lock) => lock,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return,
        };
        if (self.holds_lease)()
            && let Ok(mut current) = self.supervisor.read_plan(self.plan_id)
            && is_verifying_run(&current, &self.run_id)
        {
            let _ = self.supervisor.recover_verification(&mut current);
        }
    }
}

fn is_verifying_run(plan: &Value, run_id: &str) -> bool {
    plan["delegationOrigin"]["phase"] == "verifying" && current_verifier_run(plan) == Some(run_id)
}

fn current_verifier_run(plan: &Value) -> Option<&str> {
    plan["runner"]["verifierRuns"].as_array()?.last()?["verifierRunId"].as_str()
}

impl SessionSupervisor {
    pub(super) fn register_verification<'a, F: Fn() -> bool>(
        &'a self,
        workspace_id: &str,
        session_id: &'a str,
        plan_id: &'a str,
        run_id: String,
        cancel: &CancellationToken,
        holds_lease: &'a F,
    ) -> Result<VerificationGuard<'a, F>, ProjectError> {
        let mut active = self
            .verifying_sessions
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        let cancel = cancel.child_token();
        match active.entry(session_id.to_owned()) {
            std::collections::hash_map::Entry::Occupied(_) => {
                return Err(ProjectError::code("verifier_in_progress"));
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(ActiveVerification {
                    workspace_id: workspace_id.to_owned(),
                    run_id: run_id.clone(),
                    cancel: cancel.clone(),
                });
            }
        }
        Ok(VerificationGuard {
            supervisor: self,
            session_id,
            plan_id,
            run_id,
            cancel,
            holds_lease,
        })
    }

    pub fn cancel_live_verification(&self, session_id: &str) {
        if let Ok(active) = self.verifying_sessions.lock()
            && let Some(run) = active.get(session_id)
        {
            run.cancel.cancel();
        }
    }

    pub(crate) fn cancel_workspace_verifications(&self, workspace_id: &str) {
        if let Ok(active) = self.verifying_sessions.lock() {
            for run in active
                .values()
                .filter(|run| run.workspace_id == workspace_id)
            {
                run.cancel.cancel();
            }
        }
    }

    /// Re-read under the transition lock, and only repair a run this host can prove is gone.
    pub(crate) fn recover_orphan_verifications(
        &self,
        workspace_id: &str,
        holds_lease: impl Fn() -> bool,
    ) -> Result<usize, ProjectError> {
        // A poisoned transition lock still serializes the narrow reread-and-repair path.
        let _transition = self
            .transitions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !holds_lease() {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let mut count = 0;
        for mut plan in self.list_workspace_plans(workspace_id) {
            if self.recover_verification(&mut plan)? {
                count += 1;
            }
        }
        Ok(count)
    }

    pub(super) fn record_verifier_run(plan: &mut Value) -> String {
        let id = format!("vrun-{}", uuid::Uuid::new_v4());
        let mut runs = plan["runner"]["verifierRuns"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        // Before Rust persisted failed runs, a report could exist without a run receipt.
        if runs.is_empty()
            && (plan["verificationReport"].is_object()
                || plan["delegationOrigin"]["verifierConversationId"].is_string())
        {
            runs.push(json!({
                "status": if plan["verificationReport"]["passed"] == true { "passed" } else { "failed" },
                "verifierConversationId": plan["delegationOrigin"]["verifierConversationId"],
                "legacy": true,
            }));
        }
        runs.push(json!({"verifierRunId": id, "status": "running", "startedAt": now_iso()}));
        if !plan["runner"].is_object() {
            plan["runner"] = json!({});
        }
        plan["runner"]["verifierRuns"] = json!(runs);
        id
    }

    pub(super) async fn verify_plan(
        &self,
        updated: &mut Value,
        ev_refs: &mut HashSet<String>,
        verifier_run_id: &str,
        focus: Option<&str>,
        model: &NativeModel,
        cancel: &CancellationToken,
    ) {
        let child = cancel.child_token();
        let _cancel_on_drop = child.clone().drop_guard();
        let interactive_bridge = self.interactive_bridge();
        let interactive_enabled = self.is_interactive_publishing_available();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(ProjectError::code("CANCELLED")),
            result = tokio::time::timeout(VERIFIER_TIMEOUT, Box::pin(run_independent_verifier_with_interactive(
                &self.data_home, updated, ev_refs, focus, model, interactive_bridge, interactive_enabled, &child,
            ))) => result.unwrap_or_else(|_| Err(ProjectError::code("verifier_timeout"))),
        };
        child.cancel();
        let interrupted = result
            .as_ref()
            .err()
            .filter(|err| matches!(err.code, "CANCELLED" | "verifier_timeout"));
        if let Some(err) = interrupted {
            Self::finish_verifier_run(updated, "interrupted", Some(err.code));
            updated["delegationOrigin"]["independentVerifier"] = json!("failed");
            updated["verificationReport"] = json!({"passed": false, "error": err.code});
            return;
        }

        updated["delegationOrigin"]["verifierConversationId"] = Value::Null;
        updated["delegationOrigin"]["verifierModel"] = json!(model.model_id());
        updated["delegationOrigin"]["sameFamilyAsWorker"] = Value::Null;
        updated["modelReviews"] = json!([]);
        updated["modelReviewSourceRevision"] = Value::Null;
        if let Some(results) = updated["criterionResults"].as_array_mut() {
            results.retain(|result| result["verifiedBy"] != "independent_verifier");
        }
        match result {
            Ok(VerifierOutcome::Verified {
                report,
                verifier_conversation_id,
                verifier_model_id,
                same_family_as_worker,
                verifier_evidence_refs,
            }) => {
                updated["delegationOrigin"]["verifierConversationId"] =
                    json!(verifier_conversation_id);
                updated["delegationOrigin"]["verifierModel"] = json!(verifier_model_id);
                updated["delegationOrigin"]["sameFamilyAsWorker"] = json!(same_family_as_worker);
                updated["delegationOrigin"]["independentVerifier"] =
                    json!(if report.passed { "passed" } else { "failed" });
                updated["verificationReport"] =
                    serde_json::to_value(&report).unwrap_or(Value::Null);
                ev_refs.extend(verifier_evidence_refs);
                let review_refs = if report.evidence_refs.is_empty() {
                    let mut all: Vec<String> = ev_refs.iter().cloned().collect();
                    all.sort();
                    all
                } else {
                    report.evidence_refs.clone()
                };
                let verified_at = now_iso();
                let source_rev = format!("vsrc-{verifier_run_id}");
                // Record verified `command` / `test` criteria in `criterionResults`
                // backed by real host-indexed evidence from the independent verifier.
                if !review_refs.is_empty() {
                    let mut criterion_results = updated["criterionResults"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let existing_ids: HashSet<String> = criterion_results
                        .iter()
                        .filter_map(|r| r["criterionId"].as_str().map(str::to_owned))
                        .collect();
                    let primary_ref = review_refs[0].clone();
                    if let Some(criteria) = updated["successCriteria"].as_array() {
                        for (idx, c) in criteria.iter().enumerate() {
                            if !matches!(c["kind"].as_str(), Some("command" | "test")) {
                                continue;
                            }
                            let cid = c["id"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| format!("c-{}", idx + 1));
                            if existing_ids.contains(&cid) {
                                continue;
                            }
                            let explicitly_failed = report
                                .failed_criteria
                                .iter()
                                .any(|fc| fc.criterion_id.as_deref() == Some(cid.as_str()));
                            let passed = report.passed && !explicitly_failed;
                            criterion_results.push(json!({
                                "criterionId": cid,
                                "passed": passed,
                                "status": if passed { "passed" } else { "failed" },
                                "evidenceRef": primary_ref,
                                "evidenceRefs": review_refs,
                                "verifiedBy": "independent_verifier",
                                "verifierRunId": verifier_run_id,
                                "checkedAt": verified_at,
                            }));
                        }
                    }
                    if !criterion_results.is_empty() {
                        updated["criterionResults"] = Value::Array(criterion_results);
                    }
                }

                let reviews: Vec<Value> = updated["successCriteria"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                    .filter(|(_, c)| c["kind"] == "model_review")
                    .map(|(idx, c)| {
                        let cid = c["id"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("c-{}", idx + 1));
                        let explicitly_failed = report
                            .failed_criteria
                            .iter()
                            .any(|fc| fc.criterion_id.as_deref() == Some(cid.as_str()));
                        let passed = report.passed && !explicitly_failed;
                        json!({
                            "criterionId": cid,
                            "passed": passed,
                            "evidenceRefs": review_refs,
                            "summary": report.summary,
                            "verifierModel": verifier_model_id,
                            "sameFamilyAsWorker": same_family_as_worker,
                            "verifierRunId": verifier_run_id,
                            "sourceRevision": source_rev,
                            "verifiedAt": verified_at,
                        })
                    })
                    .collect();
                if !reviews.is_empty() {
                    updated["modelReviewSourceRevision"] = json!(source_rev);
                    updated["modelReviews"] = json!(reviews);
                }
            }
            Ok(VerifierOutcome::InvalidReport {
                error,
                summary,
                verifier_conversation_id,
            }) => {
                if !verifier_conversation_id.is_empty() {
                    updated["delegationOrigin"]["verifierConversationId"] =
                        json!(verifier_conversation_id);
                }
                updated["delegationOrigin"]["independentVerifier"] = json!("failed");
                updated["verificationReport"] = json!({
                    "passed": false,
                    "error": error,
                    "summary": summary,
                });
            }
            Err(err) => {
                updated["delegationOrigin"]["independentVerifier"] = json!("failed");
                updated["verificationReport"] = json!({
                    "passed": false,
                    "error": err.code,
                    "summary": err.detail,
                });
            }
        }
        let status = if updated["verificationReport"]["passed"] == true {
            "passed"
        } else {
            "failed"
        };
        Self::finish_verifier_run(updated, status, None);
    }

    pub(super) fn finish_verifier_run(plan: &mut Value, status: &str, error: Option<&str>) {
        let conversation = plan["delegationOrigin"]["verifierConversationId"].clone();
        let model = plan["delegationOrigin"]["verifierModel"].clone();
        let same_family = plan["delegationOrigin"]["sameFamilyAsWorker"].clone();
        let report_snapshot = plan["verificationReport"].clone();
        if let Some(run) = plan["runner"]["verifierRuns"]
            .as_array_mut()
            .and_then(|runs| runs.last_mut())
        {
            run["status"] = json!(status);
            run["completedAt"] = json!(now_iso());
            if let Some(error) = error {
                run["error"] = json!(error);
                run["failureReason"] = json!(error);
            } else {
                run["verifierConversationId"] = conversation;
                run["verifierModel"] = model;
                run["sameFamilyAsWorker"] = same_family;
                if let Some(summary) = report_snapshot["summary"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    run["summary"] = json!(summary);
                }
                if status != "passed" {
                    let reason = report_snapshot["error"]
                        .as_str()
                        .or_else(|| report_snapshot["summary"].as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    if let Some(reason) = reason {
                        run["failureReason"] = json!(reason);
                    }
                    if let Some(err) = report_snapshot["error"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        run["error"] = json!(err);
                    }
                }
                if report_snapshot.is_object() {
                    run["report"] = json!({
                        "failedCriteria": report_snapshot["failedCriteria"],
                        "missingEvidence": report_snapshot["missingEvidence"],
                        "risks": report_snapshot["risks"],
                        "recommendedNextAction": report_snapshot["recommendedNextAction"],
                        "evidenceRefs": report_snapshot["evidenceRefs"],
                    });
                }
            }
        }
    }

    pub fn notify_reverified_result(&self, workspace_id: &str, session_id: &str, plan_id: &str) {
        self.emit_event(
            workspace_id,
            "report_available",
            session_id,
            json!({
                "planId": plan_id,
                "status": "completed",
                "reverified": true,
            }),
        );
    }

    pub async fn reverify_session(
        &self,
        plan: Value,
        focus: Option<&str>,
        model: &NativeModel,
        cancel: &CancellationToken,
        holds_lease: impl Fn() -> bool,
    ) -> Result<Value, ProjectError> {
        let session_id = plan["delegationOrigin"]["sessionId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
        let workspace_id = plan["delegationOrigin"]["workspaceId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
        let plan_id = plan["planId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
        let guard;
        let (started, run_id) = {
            let _transition = self.transition_lock()?;
            if !holds_lease() {
                return Err(ProjectError::code("LEASE_REQUIRED"));
            }
            let mut current = self.read_plan(plan_id)?;
            if current["delegationOrigin"]["phase"] == "verifying" {
                return Err(ProjectError::code("verifier_in_progress"));
            }
            if current != plan {
                return Err(ProjectError::code("session_state_changed"));
            }
            if current["resultAcceptance"]["acceptedAt"].is_string() {
                return Err(ProjectError::code("session_already_accepted"));
            }
            if derive_session_status(&current) != "result_ready"
                || current["delegationOrigin"]["supersededBy"].is_string()
            {
                return Err(ProjectError::code("session_not_completed"));
            }
            if current["runner"]["verifierRuns"]
                .as_array()
                .is_some_and(|runs| runs.len() >= MAX_VERIFIER_RUNS)
            {
                return Err(ProjectError::code("reverify_limit_exceeded"));
            }
            if cancel.is_cancelled() {
                return Err(ProjectError::code("CANCELLED"));
            }
            let run_id = Self::record_verifier_run(&mut current);
            guard = self.register_verification(
                workspace_id,
                session_id,
                plan_id,
                run_id.clone(),
                cancel,
                &holds_lease,
            )?;
            current["delegationOrigin"]["phase"] = json!("verifying");
            self.write_plan(&current)?;
            (current, run_id)
        };

        let mut updated = started.clone();
        updated["delegationOrigin"]["verifierConversationId"] = Value::Null;
        self.evaluate_deterministic_criteria(&mut updated);
        let mut refs = self.indexed_evidence_refs_for_plan(&updated);
        self.verify_plan(
            &mut updated,
            &mut refs,
            &run_id,
            focus,
            model,
            guard.token(),
        )
        .await;
        let interrupted = updated["runner"]["verifierRuns"]
            .as_array()
            .and_then(|runs| runs.last())
            .filter(|run| run["status"] == "interrupted")
            .cloned();

        {
            let _transition = self.transition_lock()?;
            if !holds_lease() {
                return Err(ProjectError::code("LEASE_REQUIRED"));
            }
            let current = self.read_plan(plan_id)?;
            if current != started {
                // The guard will repair an orphan of this run against the latest snapshot.
                return Err(ProjectError::code("session_state_changed"));
            }
            if guard.token().is_cancelled() && interrupted.is_none() {
                return Err(ProjectError::code("CANCELLED"));
            }
            if let Some(run) = interrupted.as_ref() {
                let runs = updated["runner"]["verifierRuns"].clone();
                updated = started;
                updated["runner"]["verifierRuns"] = runs;
                updated["delegationOrigin"]["phase"] = json!("completed");
                self.write_plan(&updated)?;
                let code = if run["error"] == "CANCELLED" {
                    "CANCELLED"
                } else {
                    "verifier_timeout"
                };
                return Err(ProjectError::code(code));
            }
            let mut refs: Vec<_> = refs.into_iter().collect();
            refs.sort();
            updated["evidenceRefs"] = json!(refs);
            updated["delegationOrigin"]["phase"] = json!("completed");
            updated["updatedAt"] = json!(now_iso());
            self.write_plan(&updated)?;
        }
        drop(guard);
        // A new verifier verdict is a new report revision. A historical citation cannot
        // settle this revision until it is delivered through the normal reply path.
        let decision =
            self.settle_session(workspace_id, session_id, false, false, None, holds_lease())?;
        Ok(json!({
            "ok": true,
            "sessionId": session_id,
            "planId": plan_id,
            "decision": decision,
            "reverified": true,
            "verificationReport": updated["verificationReport"],
            "verifierRunCount": updated["runner"]["verifierRuns"].as_array().map(Vec::len),
        }))
    }

    pub(super) fn recover_verification(&self, plan: &mut Value) -> Result<bool, ProjectError> {
        if plan["delegationOrigin"]["phase"] != "verifying"
            || plan["delegationOrigin"]["sessionId"]
                .as_str()
                .is_some_and(|sid| {
                    self.verifying_sessions.lock().map_or(true, |active| {
                        active.get(sid).is_some_and(|entry| {
                            current_verifier_run(plan) == Some(entry.run_id.as_str())
                        })
                    })
                })
        {
            return Ok(false);
        }
        let protected_phase = if plan["status"] == "cancelled"
            || plan["delegationOrigin"]["cancellation"]["disposition"] == "user_withdrawn"
            || plan["delegationOrigin"]["cancellation"]["phase"] == "completed"
        {
            Some("cancelled")
        } else if plan["status"] == "failed" {
            Some("failed")
        } else if plan["resultAcceptance"]["acceptedAt"].is_string() {
            Some("accepted")
        } else if plan["delegationOrigin"]["supersededBy"].is_string() {
            Some("superseded")
        } else {
            None
        };
        if let Some(phase) = protected_phase {
            Self::finish_verifier_run(plan, "interrupted", Some("verifier_host_interrupted"));
            plan["delegationOrigin"]["phase"] = json!(phase);
            self.write_plan(plan)?;
            return Ok(true);
        }
        let initial = plan["status"] != "completed";
        Self::finish_verifier_run(plan, "interrupted", Some("verifier_host_interrupted"));
        if initial {
            // The worker already finished before entering the verifier. Keep its result available.
            let refs = self.indexed_evidence_refs_for_plan(plan);
            Self::complete_worker_plan(plan, refs);
            plan["delegationOrigin"]["independentVerifier"] = json!("failed");
            plan["verificationReport"] =
                json!({"passed": false, "error": "verifier_host_interrupted"});
        }
        plan["delegationOrigin"]["phase"] = json!("completed");
        if initial {
            self.persist_terminal_transition(plan, "host_recovery")?;
        } else {
            self.write_plan(plan)?;
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use peer_runtime::model::{
        ModelConfig,
        wire::{GenerationOptions, Wire},
    };
    use std::cell::Cell;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
    };

    #[tokio::test]
    async fn autonomy_verification_fences_late_results_after_cancel_timeout_or_lease_change() {
        for error in [
            "CANCELLED",
            "verifier_timeout",
            "LEASE_REQUIRED",
            "session_state_changed",
            "user_withdrawn",
        ] {
            check_interrupted_verification(error).await;
        }
    }

    async fn check_interrupted_verification(expected_error: &str) {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("README.md"), "current evidence").unwrap();
        // The verifier reads the delegating Bot's real policy, so the plan is
        // owned by the Bot profile that a delegated plan always has.
        let host = crate::NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
        let (entry, _profile) = host
            .bind_workspace(workspace.path(), Some("FenceBot"))
            .unwrap();
        let workspace_id = entry.workspace_id.clone();
        let sup = host.supervisor();
        let plan = json!({
            "planId":"plan-reverify-fence", "conversationId":"reverify-fence",
            "targetWorkspacePath": workspace.path(), "status":"completed",
            "delegationOrigin":{
                "sessionId":"reverify-fence", "workspaceId": entry.workspace_id,
                "readOnly":true, "phase":"completed", "independentVerifier":"failed"
            },
            "successCriteria":[{"id":"file", "kind":"file-exists", "path":"README.md"}],
            "verificationReport":{"passed":false, "error":"previous_failure"}
        });
        sup.save_plan_json(&plan).unwrap();

        let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let model = NativeModel::new(
            ModelConfig {
                endpoint: format!("http://{}/chat/completions", socket.local_addr().unwrap()),
                model: "mock-verifier".to_owned(),
                provider: "openai".to_owned(),
                wire: Wire::Chat,
                generation: GenerationOptions::default(),
            },
            None,
            Duration::from_secs(600),
        )
        .unwrap();
        let (reached_tx, reached_rx) = oneshot::channel();
        let (verdict_tx, verdict_rx) = oneshot::channel::<String>();
        let server = tokio::spawn(async move {
            let (mut stream, _) = socket.accept().await.unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                headers.push(stream.read_u8().await.unwrap());
            }
            let head = String::from_utf8(headers).unwrap().to_ascii_lowercase();
            let len: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            stream.read_exact(&mut vec![0; len]).await.unwrap();
            reached_tx.send(()).unwrap();
            let Ok(verdict) = verdict_rx.await else {
                return;
            };
            let chunk =
                json!({"choices":[{"index":0,"delta":{"content":verdict},"finish_reason":"stop"}]});
            let usage = json!({"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":4,"total_tokens":19}});
            let body = format!("data: {chunk}\n\ndata: {usage}\n\ndata: [DONE]\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let cancel = CancellationToken::new();
        let owns_lease = Cell::new(true);
        let verifier =
            sup.reverify_session(plan.clone(), None, &model, &cancel, || owns_lease.get());
        let race = async {
            tokio::time::timeout(Duration::from_secs(5), reached_rx)
                .await
                .unwrap()
                .unwrap();
            let active = sup.read_plan("plan-reverify-fence").unwrap();
            assert_eq!(active["delegationOrigin"]["phase"], "verifying");
            let duplicate = sup
                .reverify_session(active, None, &model, &cancel, || true)
                .await
                .unwrap_err();
            assert_eq!(duplicate.code, "verifier_in_progress");
            let refs = sup.indexed_evidence_refs_for_plan(&plan);
            assert!(!refs.is_empty());
            match expected_error {
                "CANCELLED" => {
                    sup.cancel_live_verification("reverify-fence");
                    Some(verdict_tx)
                }
                "verifier_timeout" => {
                    tokio::time::pause();
                    tokio::time::advance(VERIFIER_TIMEOUT + Duration::from_secs(1)).await;
                    Some(verdict_tx)
                }
                "user_withdrawn" => {
                    sup.control_session(
                        &workspace_id,
                        "reverify-fence",
                        "cancel",
                        "user_withdrawn",
                        true,
                    )
                    .unwrap();
                    Some(verdict_tx)
                }
                "LEASE_REQUIRED" | "session_state_changed" => {
                    if expected_error == "LEASE_REQUIRED" {
                        owns_lease.set(false);
                    } else {
                        sup.reprioritize_session(&workspace_id, "reverify-fence", "high", true)
                            .unwrap();
                    }
                    verdict_tx.send(json!({
                        "passed": true, "failedCriteria":[], "missingEvidence":[], "risks":[],
                        "evidenceRefs":refs, "summary":"Checked current file on disk"
                    }).to_string()).unwrap();
                    None
                }
                _ => unreachable!("unknown test interruption"),
            }
        };
        let (rejected, held_response) = tokio::join!(verifier, race);
        if expected_error == "verifier_timeout" {
            tokio::time::resume();
        }
        drop(held_response);
        server.await.unwrap();
        assert_eq!(
            rejected.unwrap_err().code,
            if expected_error == "user_withdrawn" {
                "session_state_changed"
            } else {
                expected_error
            }
        );
        let mut active = sup.read_plan("plan-reverify-fence").unwrap();
        assert_eq!(active["verificationReport"], plan["verificationReport"]);
        if expected_error == "LEASE_REQUIRED" {
            assert!(sup.recover_verification(&mut active).unwrap());
        }

        if expected_error == "user_withdrawn" {
            assert_eq!(active["delegationOrigin"]["phase"], "cancelled");
            assert_eq!(
                active["delegationOrigin"]["cancellation"]["disposition"],
                "user_withdrawn"
            );
        } else {
            assert_eq!(active["delegationOrigin"]["phase"], "completed");
        }
        assert_eq!(active["runner"]["verifierRuns"][1]["status"], "interrupted");
        assert_eq!(active["verificationReport"], plan["verificationReport"]);
    }

    #[tokio::test]
    async fn maintenance_repairs_only_orphan_verifiers_and_blocking_panic_releases_its_run() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let host = Arc::new(crate::NativeProjectHost::new(home.path(), "test", Some(1)).unwrap());
        let (entry, profile) = host
            .bind_workspace(workspace.path(), Some("Orphans"))
            .unwrap();
        let workspace_id = entry.workspace_id;
        host.ensure_lease(&workspace_id).unwrap();
        let supervisor = host.supervisor();
        let parent = profile.agent_conversation_id.unwrap();
        let seed = |id: &str, status: &str| {
            json!({
                "planId": id, "conversationId": id, "title": id, "status": status,
                "updatedAt": "2026-11-25T01:01:00.000Z",
                "delegationOrigin": {
                    "workspaceId": workspace_id, "sessionId": id, "parentConversationId": parent,
                    "phase": "verifying", "lastWorkerOutput": "durable worker output", "readOnly": true
                }
            })
        };
        let mut orphan = seed("plan-orphan", "executing");
        SessionSupervisor::record_verifier_run(&mut orphan);
        supervisor.save_plan_json(&orphan).unwrap();

        let mut live = seed("plan-live", "completed");
        let live_id = SessionSupervisor::record_verifier_run(&mut live);
        let cancel = CancellationToken::new();
        let guard = supervisor
            .register_verification(
                &workspace_id,
                "plan-live",
                "plan-live",
                live_id,
                &cancel,
                &|| true,
            )
            .unwrap();
        supervisor.save_plan_json(&live).unwrap();
        let report = host
            .run_background_maintenance(&workspace_id, "2026-11-25T08:00:00.000Z", None, &cancel)
            .await
            .unwrap();
        assert_eq!(report.recovered_verifications, 1);
        assert_eq!(supervisor.read_plan("plan-live").unwrap(), live);
        assert!(!guard.token().is_cancelled());

        let recovered = supervisor.read_plan("plan-orphan").unwrap();
        assert_eq!(recovered["status"], "completed");
        assert_eq!(
            recovered["delegationOrigin"]["lastWorkerOutput"],
            "durable worker output"
        );
        assert_eq!(
            recovered["runner"]["verifierRuns"][0]["error"],
            "verifier_host_interrupted"
        );
        // A newer run is still fenced from cleanup by the older guard.
        let replacement_id = SessionSupervisor::record_verifier_run(&mut live);
        supervisor.save_plan_json(&live).unwrap();
        drop(guard);
        assert_eq!(supervisor.read_plan("plan-live").unwrap(), live);

        let join_host = Arc::clone(&host);
        let join = tokio::task::spawn_blocking(move || {
            let _guard = join_host
                .supervisor()
                .register_verification(
                    &workspace_id,
                    "plan-live",
                    "plan-live",
                    replacement_id,
                    &cancel,
                    &|| true,
                )
                .unwrap();
            panic!("synthetic blocking verifier panic");
        })
        .await;
        assert!(join.unwrap_err().is_panic());
        let failed_run = supervisor.read_plan("plan-live").unwrap();
        assert_eq!(failed_run["delegationOrigin"]["phase"], "completed");
        assert_eq!(
            failed_run["runner"]["verifierRuns"][1]["error"],
            "verifier_host_interrupted"
        );
    }

    #[tokio::test]
    async fn reverify_session_requires_delivery_of_the_new_revision_and_persists_run_summary() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("README.md"), "verified content").unwrap();
        let host = crate::NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
        let (entry, profile) = host
            .bind_workspace(workspace.path(), Some("SettleBot"))
            .unwrap();
        let ws_id = entry.workspace_id;
        let parent_id = profile.agent_conversation_id.unwrap();
        let sup = host.supervisor();

        // Seed parent conversation with a prior agent_reply citing `reverify-settle`.
        sup.conversations
            .append_message_idempotent(
                &parent_id,
                &json!({
                    "id": "reply-prior-1",
                    "role": "assistant",
                    "kind": "agent_reply",
                    "content": "Initial report delivered.",
                    "sources": ["reverify-settle"],
                    "createdAt": "2026-11-25T01:01:00.000Z",
                }),
                "2026-11-25T01:01:00.000Z",
                None,
            )
            .unwrap();

        let plan = json!({
            "planId": "plan-reverify-settle",
            "conversationId": "reverify-settle",
            "targetWorkspacePath": workspace.path(),
            "status": "completed",
            "tasks": [{
                "taskId": "task-1",
                "status": "completed",
                "evidenceRefs": ["ev-seed-1"]
            }],
            "delegationOrigin": {
                "sessionId": "reverify-settle",
                "workspaceId": ws_id,
                "parentConversationId": parent_id,
                "readOnly": true,
                "phase": "completed",
                "independentVerifier": "failed"
            },
            "successCriteria": [{"id": "file", "kind": "file-exists", "path": "README.md"}],
            "verificationReport": {"passed": false, "error": "previous_failure"}
        });
        sup.save_plan_json(&plan).unwrap();

        // Register seed leaf evidence in host Evidence index so close gate can pass.
        let ev_store = EvidenceIndexStore::new(home.path());
        let grant = json!({
            "grantId": "g-seed",
            "toolCallId": "call-seed",
            "granted": true,
            "duration": "once",
            "scope": "local.file.read",
            "decidedAt": "2026-11-25T01:00:30.000Z",
        });
        let result_rec = json!({
            "toolCallId": "call-seed",
            "status": "success",
            "completedAt": "2026-11-25T01:00:31.000Z",
            "outputPreview": { "ok": true },
            "evidence": {
                "evidenceId": "ev-seed-1",
                "toolCallId": "call-seed",
                "summary": "read README.md",
                "artifactRefs": [],
            }
        });
        let registered = ev_store
            .register(
                &HostToolEvidence {
                    conversation_id: "reverify-settle",
                    plan_id: Some("plan-reverify-settle"),
                    stream_id: Some("s-seed"),
                    tool_name: "read_file",
                    capability_id: "local.file.read",
                    tool_call_id: "call-seed",
                    grant: &grant,
                    result: &result_rec,
                },
                None,
            )
            .unwrap();
        let leaf_ref = registered[0]["evidenceRef"].as_str().unwrap().to_owned();
        let mut seeded_plan = sup.read_plan("plan-reverify-settle").unwrap();
        seeded_plan["tasks"][0]["evidenceRefs"] = json!([leaf_ref]);
        sup.save_plan_json(&seeded_plan).unwrap();

        let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let model = NativeModel::new(
            ModelConfig {
                endpoint: format!("http://{}/chat/completions", socket.local_addr().unwrap()),
                model: "mock-verifier".to_owned(),
                provider: "openai".to_owned(),
                wire: Wire::Chat,
                generation: GenerationOptions::default(),
            },
            None,
            Duration::from_secs(60),
        )
        .unwrap();
        let leaf_ref_for_srv = leaf_ref.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = socket.accept().await.unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                headers.push(stream.read_u8().await.unwrap());
            }
            let head = String::from_utf8(headers).unwrap().to_ascii_lowercase();
            let len: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            stream.read_exact(&mut vec![0; len]).await.unwrap();
            let verdict = json!({
                "passed": true,
                "failedCriteria": [],
                "missingEvidence": [],
                "risks": [],
                "evidenceRefs": [leaf_ref_for_srv],
                "summary": "Verified README.md exists on disk"
            })
            .to_string();
            let chunk =
                json!({"choices":[{"index":0,"delta":{"content":verdict},"finish_reason":"stop"}]});
            let usage = json!({"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}});
            let body = format!("data: {chunk}\n\ndata: {usage}\n\ndata: [DONE]\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let cancel = CancellationToken::new();
        let out = sup
            .reverify_session(seeded_plan, None, &model, &cancel, || true)
            .await
            .unwrap();
        server.await.unwrap();

        assert_eq!(out["ok"], true);
        assert!(out["decision"]["acceptedBy"].is_null());
        let final_plan = sup.read_plan("plan-reverify-settle").unwrap();
        assert_eq!(final_plan["delegationOrigin"]["phase"], "completed");
        assert!(final_plan["resultAcceptance"].is_null());
        let last_run = final_plan["runner"]["verifierRuns"]
            .as_array()
            .and_then(|a| a.last())
            .expect("verifier run persisted");
        assert_eq!(last_run["status"], "passed");
        assert_eq!(last_run["summary"], "Verified README.md exists on disk");
    }
}
