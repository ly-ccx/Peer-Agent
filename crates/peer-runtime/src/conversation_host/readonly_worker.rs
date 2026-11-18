//! Isolated read-only cognition shared by repository exploration and independent
//! verification. The ordinary Host still owns all dispatches and their effects.
use super::*;
use peer_protocol::collect_tool_result_evidence_refs;
use peer_store::{EvidenceIndexStore, ExplorerLease, GoalStore, VerifierLease};
use std::collections::{BTreeSet, VecDeque};

const READ_CAPABILITIES: &[&str] = &[
    "local.git.query",
    "local.file.read",
    "local.file.list",
    "local.file.search",
    "local.search.aggregate",
];
const VERIFIER_IDLE: Duration = Duration::from_secs(600);
const VERIFIER_PROGRESS_HISTORY: usize = 512;

pub(super) enum WorkerLease {
    Explorer(Box<ExplorerLease>),
    Verifier(Box<VerifierLease>),
}

impl WorkerLease {
    pub(super) fn id(&self) -> &str {
        match self {
            Self::Explorer(lease) => &lease.id,
            Self::Verifier(lease) => &lease.id,
        }
    }

    pub(super) fn plan_id(&self) -> &str {
        match self {
            Self::Explorer(lease) => &lease.plan,
            Self::Verifier(lease) => lease.plan_id(),
        }
    }

    pub(super) fn tag(&self) -> &'static str {
        match self {
            Self::Explorer(_) => "nativeExplorerId",
            Self::Verifier(_) => "nativeVerifierId",
        }
    }

    pub(super) fn is_verifier(&self) -> bool {
        matches!(self, Self::Verifier(_))
    }
}

pub(super) struct Worker {
    pub lease: WorkerLease,
    pub projection: RuntimeProjection,
    pub calls: usize,
    expires: tokio::time::Instant,
    access_revision: u64,
    seen_observations: VecDeque<String>,
}

impl Worker {
    pub(super) fn admit_tool(&mut self) -> Result<(), HostError> {
        if !self.lease.is_verifier() && self.calls >= peer_store::EXPLORER_TOOL_LIMIT {
            return Err(HostError("explorer_tool_limit"));
        }
        self.calls = self
            .calls
            .checked_add(1)
            .ok_or(HostError("runtime_counter_limit"))?;
        Ok(())
    }

    pub(super) fn observe(&mut self, fact: String) {
        if self.lease.is_verifier() && !self.seen_observations.contains(&fact) {
            if self.seen_observations.len() == VERIFIER_PROGRESS_HISTORY {
                self.seen_observations.pop_front();
            }
            self.seen_observations.push_back(fact);
            self.expires = tokio::time::Instant::now() + VERIFIER_IDLE;
        }
    }

    fn includes(&self, row: &Value) -> bool {
        row[self.lease.tag()] == self.lease.id()
    }
}

impl Host<'_> {
    pub(super) async fn run_readonly_worker(
        &mut self,
        lease: WorkerLease,
        mission: &str,
        max_turns: Option<usize>,
    ) -> Result<String, HostError> {
        let projection = self.providers.project_for_mode(
            RuntimeMode::Explorer,
            Some(
                &READ_CAPABILITIES
                    .iter()
                    .filter(|id| {
                        self.allowlist
                            .as_ref()
                            .is_none_or(|allowed| allowed.iter().any(|entry| entry == **id))
                    })
                    .map(|id| (*id).to_owned())
                    .collect::<Vec<_>>(),
            ),
        )?;
        let verifier = lease.is_verifier();
        let expires = tokio::time::Instant::now()
            + if verifier {
                VERIFIER_IDLE
            } else {
                Duration::from_millis(peer_store::EXPLORER_TIMEOUT_MS)
            };
        let access_revision = self.access.snapshot()?.1;
        let old_live = std::mem::take(
            &mut self
                .pipeline
                .as_mut()
                .ok_or(HostError("native_pipeline_unavailable"))?
                .live,
        );
        let output = self.output.take();
        self.worker = Some(Worker {
            lease,
            projection,
            calls: 0,
            expires,
            access_revision,
            seen_observations: VecDeque::new(),
        });
        let work = async {
            self.append(
                &json!({"id":format!("message-{}",uuid::Uuid::new_v4()),"role":"user",
                "content":mission,"createdAt":now(),"streamId":self.identity.stream_id}),
            )?;
            let owned = self.owned.clone();
            let external = self.external.clone();
            let run = crate::turn_loop::run(self, max_turns, &owned, &external).await?;
            if run.stop != crate::turn_loop::LoopStop::Replied {
                return Err(HostError(if verifier {
                    "goal_verifier_budget_exhausted"
                } else {
                    "explorer_turn_limit"
                }));
            }
            self.source_current()?;
            Ok(run.content)
        }
        .await;
        self.output = output;
        self.pipeline
            .as_mut()
            .ok_or(HostError("native_pipeline_unavailable"))?
            .live = old_live;
        work
    }

    pub(super) fn check_worker_settled(&self, success: bool) -> Result<(), HostError> {
        if success {
            self.source_current()?;
        }
        let run = self
            .store
            .read_conversation_execution(&self.identity.conversation_id)?
            .ok_or(HostError("readonly_owner_unavailable"))?;
        if run.identity != self.identity
            || run.owner != *self.run.owner()
            || run.phase != ConversationExecutionPhase::Active
            || !run.pending_tools.is_empty()
        {
            return Err(HostError("readonly_stop_unproven"));
        }
        Ok(())
    }

    pub(super) fn check_worker(&self) -> Result<(), HostError> {
        if let Some(worker) = &self.worker {
            if tokio::time::Instant::now() >= worker.expires {
                return Err(HostError(if worker.lease.is_verifier() {
                    "verifier_no_progress"
                } else {
                    "explorer_timed_out"
                }));
            }
            if self.access.snapshot()?.1 != worker.access_revision {
                return Err(HostError("permission_policy_changed"));
            }
            let goals = GoalStore::new(&self.home);
            match &worker.lease {
                WorkerLease::Explorer(lease) => goals.check_explorer(lease)?,
                WorkerLease::Verifier(lease) => goals.check_verifier(lease)?,
            }
        }
        Ok(())
    }

    pub(super) fn project_active_history(&self) -> Result<Value, HostError> {
        let Some(worker) = &self.worker else {
            return crate::canonical_history::project_history(&self.expected.history.messages)
                .map_err(HostError);
        };
        let rows = self
            .expected
            .history
            .messages
            .iter()
            .filter(|row| worker.includes(row))
            .map(|row| {
                let mut row = row.clone();
                if let Some(fields) = row.as_object_mut() {
                    fields.remove("kind");
                }
                row
            })
            .collect::<Vec<_>>();
        crate::canonical_history::project_history(&rows).map_err(HostError)
    }

    pub(super) fn worker_evidence(&self, worker: &Worker) -> Result<BTreeSet<String>, HostError> {
        let mut observed = BTreeSet::new();
        let index = EvidenceIndexStore::new(&self.home);
        for message in self
            .expected
            .history
            .messages
            .iter()
            .filter(|row| worker.includes(row))
        {
            for segment in message["segments"].as_array().into_iter().flatten() {
                let result = &segment["result"];
                let Some(call) = segment["toolCallId"].as_str() else {
                    continue;
                };
                if result["toolCallId"] != call
                    || result["status"] != "success"
                    || result["evidence"]["dispatchOutcome"] == "not_dispatched"
                    || !message["permissionGrants"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|grant| grant["toolCallId"] == call && grant["granted"] == true)
                {
                    continue;
                }
                let refs = collect_tool_result_evidence_refs(Some(call), result)
                    .map_err(|_| HostError("readonly_evidence_invalid"))?;
                for row in index.find(&refs, None)? {
                    if row["conversationId"] == self.identity.conversation_id
                        && row["streamId"] == self.identity.stream_id
                        && row["planId"] == worker.lease.plan_id()
                        && row["toolCallId"] == call
                        && row["capabilityId"] == result["capabilityId"]
                    {
                        observed.extend(row["evidenceRef"].as_str().map(str::to_owned));
                    }
                }
            }
        }
        Ok(observed)
    }
}
