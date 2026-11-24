use super::*;
use crate::verifier::{VerifierOutcome, run_independent_verifier_with_focus};

const MAX_VERIFIER_RUNS: usize = 3;
const VERIFIER_TIMEOUT: Duration = Duration::from_secs(300);

struct VerificationGuard<'a> {
    active: &'a Mutex<HashSet<String>>,
    session_id: &'a str,
}

impl Drop for VerificationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(self.session_id);
        }
    }
}

impl SessionSupervisor {
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
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(ProjectError::code("CANCELLED")),
            result = tokio::time::timeout(VERIFIER_TIMEOUT, Box::pin(run_independent_verifier_with_focus(
                &self.data_home, updated, ev_refs, focus, model, &child,
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
        if let Some(run) = plan["runner"]["verifierRuns"]
            .as_array_mut()
            .and_then(|runs| runs.last_mut())
        {
            run["status"] = json!(status);
            run["completedAt"] = json!(now_iso());
            if let Some(error) = error {
                run["error"] = json!(error);
            } else {
                run["verifierConversationId"] = conversation;
                run["verifierModel"] = model;
                run["sameFamilyAsWorker"] = same_family;
            }
        }
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
        let guard = {
            let mut active = self
                .verifying_sessions
                .lock()
                .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
            if !active.insert(session_id.to_owned()) {
                return Err(ProjectError::code("verifier_in_progress"));
            }
            VerificationGuard {
                active: &self.verifying_sessions,
                session_id,
            }
        };
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
            current["delegationOrigin"]["phase"] = json!("verifying");
            current["updatedAt"] = json!(now_iso());
            self.write_plan(&current)?;
            (current, run_id)
        };

        let mut updated = started.clone();
        updated["delegationOrigin"]["verifierConversationId"] = Value::Null;
        self.evaluate_deterministic_criteria(&mut updated);
        let mut refs = self.indexed_evidence_refs_for_plan(&updated);
        self.verify_plan(&mut updated, &mut refs, &run_id, focus, model, cancel)
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
            let mut current = self.read_plan(plan_id)?;
            if current != started {
                if current["delegationOrigin"]["phase"] == "verifying"
                    && current["runner"]["verifierRuns"]
                        .as_array()
                        .and_then(|runs| runs.last())
                        .is_some_and(|run| run["verifierRunId"] == run_id)
                {
                    Self::finish_verifier_run(
                        &mut current,
                        "interrupted",
                        Some("session_state_changed"),
                    );
                    current["delegationOrigin"]["phase"] = json!("completed");
                    self.write_plan(&current)?;
                }
                return Err(ProjectError::code("session_state_changed"));
            }
            if let Some(run) = interrupted.as_ref() {
                let runs = updated["runner"]["verifierRuns"].clone();
                updated = started;
                updated["runner"]["verifierRuns"] = runs;
                updated["delegationOrigin"]["phase"] = json!("completed");
                updated["updatedAt"] = json!(now_iso());
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
        let decision = self.settle_session(workspace_id, session_id, false, false, None, true)?;
        Ok(json!({
            "ok": true,
            "sessionId": session_id,
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
                    self.verifying_sessions
                        .lock()
                        .map_or(true, |active| active.contains(sid))
                })
        {
            return Ok(false);
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
        plan["updatedAt"] = json!(now_iso());
        self.write_plan(plan)?;
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
        for error in ["CANCELLED", "verifier_timeout", "LEASE_REQUIRED"] {
            check_interrupted_verification(error).await;
        }
    }

    async fn check_interrupted_verification(expected_error: &str) {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("README.md"), "current evidence").unwrap();
        let sup = SessionSupervisor::new(home.path(), None);
        let plan = json!({
            "planId":"plan-reverify-fence", "conversationId":"reverify-fence",
            "targetWorkspacePath": workspace.path(), "status":"completed",
            "delegationOrigin":{
                "sessionId":"reverify-fence", "workspaceId":"ws-fence",
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
                    cancel.cancel();
                    Some(verdict_tx)
                }
                "verifier_timeout" => {
                    tokio::time::pause();
                    tokio::time::advance(VERIFIER_TIMEOUT + Duration::from_secs(1)).await;
                    Some(verdict_tx)
                }
                "LEASE_REQUIRED" => {
                    owns_lease.set(false);
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
        assert_eq!(rejected.unwrap_err().code, expected_error);
        let mut active = sup.read_plan("plan-reverify-fence").unwrap();
        assert_eq!(active["verificationReport"], plan["verificationReport"]);
        if expected_error == "LEASE_REQUIRED" {
            assert!(sup.recover_verification(&mut active).unwrap());
        }

        assert_eq!(active["delegationOrigin"]["phase"], "completed");
        assert_eq!(active["runner"]["verifierRuns"][1]["status"], "interrupted");
        assert_eq!(active["verificationReport"], plan["verificationReport"]);
    }
}
