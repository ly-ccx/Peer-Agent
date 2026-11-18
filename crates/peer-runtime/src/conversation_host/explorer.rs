//! Explorer is a bounded read-only turn under the live ordinary Host owner.
use super::*;
use crate::providers::goal::explorer::{CAPABILITY, ExplorerRequest};
use peer_protocol::{JsonLimits, collect_tool_result_evidence_refs, decode_json_bounded};
use peer_store::{
    AutomaticInspect, EvidenceIndexStore, ExplorerDispatch, ExplorerLease, ExplorerSettlement,
    GoalStore, LocalGoalIntake,
};
use std::collections::BTreeSet;

pub(super) struct Worker {
    pub lease: ExplorerLease,
    pub projection: RuntimeProjection,
    pub calls: usize,
    pub expires: tokio::time::Instant,
    pub access_revision: u64,
}

const READ_CAPABILITIES: &[&str] = &[
    "local.git.query",
    "local.file.read",
    "local.file.list",
    "local.file.search",
    "local.search.aggregate",
];

pub(super) fn settled_parent_calls<'a>(
    history: &'a HistorySnapshot,
    stream: &'a str,
    capability: &'a str,
) -> impl Iterator<Item = (&'a str, &'a Value)> {
    history
        .history
        .messages
        .iter()
        .filter(move |message| {
            message["streamId"] == stream && !message["nativeExplorerId"].is_string()
        })
        .flat_map(move |message| {
            message["segments"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(move |segment| {
                    let result = &segment["result"];
                    let id = segment["toolCallId"].as_str()?;
                    (segment["type"] == "tool-call"
                        && result["toolCallId"] == id
                        && result["capabilityId"] == capability
                        && result["status"] == "success"
                        && message["permissionGrants"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|grant| grant["toolCallId"] == id && grant["granted"] == true))
                    .then_some((id, segment))
                })
        })
}

impl Host<'_> {
    pub(super) async fn drive_requested_explorers(&mut self) -> Result<(), HostError> {
        self.source_current()?;
        let requests = settled_parent_calls(&self.expected, &self.identity.stream_id, CAPABILITY)
            .filter_map(|(id, segment)| {
                ExplorerRequest::parse(&segment["args"])
                    .ok()
                    .map(|request| (id.to_owned(), request))
            })
            .take(4)
            .collect::<Vec<_>>();
        if requests.len() > 3 {
            return Err(HostError("explorer_dispatch_limit"));
        }
        for (id, request) in requests {
            self.run_requested_explorer(&id, request, None).await?;
        }
        Ok(())
    }

    pub(super) async fn run_requested_explorer(
        &mut self,
        id: &str,
        request: ExplorerRequest,
        inspect: Option<AutomaticInspect<'_>>,
    ) -> Result<Option<LocalGoalIntake>, HostError> {
        let store = GoalStore::new(&self.home);
        let projector = crate::goal_facts::TuiGoalProjector::new(&now()).map_err(HostError)?;
        let request =
            serde_json::to_value(request).map_err(|_| HostError("explorer_request_invalid"))?;
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
        let Some(lease) = store.begin_explorer(
            ExplorerDispatch {
                id,
                conversation: &self.identity.conversation_id,
                stream: &self.identity.stream_id,
                workspace: &self.workspace,
                request: &request,
                at: &now(),
                inspect,
            },
            &projector,
            || self.source_current().map_err(|err| err.0),
        )?
        else {
            // A registered request can await a real Goal and its approval.
            return Ok(None);
        };
        let old_live = std::mem::take(
            &mut self
                .pipeline
                .as_mut()
                .ok_or(HostError("native_pipeline_unavailable"))?
                .live,
        );
        let output = self.output.take();
        let authority = self.access.snapshot()?.1;
        self.explorer = Some(Worker {
            lease,
            projection,
            calls: 0,
            access_revision: authority,
            expires: tokio::time::Instant::now()
                + Duration::from_millis(peer_store::EXPLORER_TIMEOUT_MS),
        });
        let work = async {
            let worker = self
                .explorer
                .as_ref()
                .ok_or(HostError("explorer_owner_unavailable"))?;
            let mission = format!(
                "Explorer mission for plan \"{}\".\nQuestion: {}",
                worker.lease.title,
                worker.lease.request["question"]
                    .as_str()
                    .ok_or(HostError("explorer_request_invalid"))?
            );
            self.append(
                &json!({"id":format!("message-{}",uuid::Uuid::new_v4()),"role":"user",
                "content":mission,"createdAt":now(),"streamId":self.identity.stream_id}),
            )?;
            let owned = self.owned.clone();
            let external = self.external.clone();
            let run = crate::turn_loop::run(
                self,
                Some(peer_store::EXPLORER_TOOL_LIMIT + 1),
                &owned,
                &external,
            )
            .await?;
            if run.stop != crate::turn_loop::LoopStop::Replied {
                return Err(HostError("explorer_turn_limit"));
            }
            self.source_current()?;
            self.explorer_report(&run.content)
        }
        .await;
        self.output = output;
        self.pipeline
            .as_mut()
            .ok_or(HostError("native_pipeline_unavailable"))?
            .live = old_live;
        let worker = self
            .explorer
            .take()
            .ok_or(HostError("explorer_owner_unavailable"))?;
        let failure = work.as_ref().err().copied();
        let settlement = match work {
            Ok(report) => ExplorerSettlement::Completed(report),
            Err(error) => ExplorerSettlement::Failed(error.0),
        };
        let next = store.finish_explorer(&worker.lease, settlement, &now(), || {
            self.check_worker_settled(failure.is_none())
                .map_err(|e| e.0)
        })?;
        failure.map_or(Ok(next), Err)
    }

    fn check_worker_settled(&self, success: bool) -> Result<(), HostError> {
        if success {
            self.source_current()?;
        }
        let run = self
            .store
            .read_conversation_execution(&self.identity.conversation_id)?
            .ok_or(HostError("explorer_owner_unavailable"))?;
        if run.identity != self.identity
            || run.owner != *self.run.owner()
            || run.phase != ConversationExecutionPhase::Active
            || !run.pending_tools.is_empty()
        {
            return Err(HostError("explorer_stop_unproven"));
        }
        Ok(())
    }

    pub(super) fn check_explorer(&self) -> Result<(), HostError> {
        if let Some(worker) = &self.explorer {
            if tokio::time::Instant::now() >= worker.expires {
                return Err(HostError("explorer_timed_out"));
            }
            if self.access.snapshot()?.1 != worker.access_revision {
                return Err(HostError("permission_policy_changed"));
            }
            GoalStore::new(&self.home).check_explorer(&worker.lease)?;
        }
        Ok(())
    }

    pub(super) fn project_active_history(&self) -> Result<Value, HostError> {
        let Some(worker) = &self.explorer else {
            return crate::canonical_history::project_history(&self.expected.history.messages)
                .map_err(HostError);
        };
        let worker_rows = self
            .expected
            .history
            .messages
            .iter()
            .filter(|row| row["nativeExplorerId"] == worker.lease.id)
            .map(|message| {
                let mut message = message.clone();
                if let Some(row) = message.as_object_mut() {
                    row.remove("kind");
                }
                message
            })
            .collect::<Vec<_>>();
        crate::canonical_history::project_history(&worker_rows).map_err(HostError)
    }

    fn explorer_report(&self, content: &str) -> Result<Value, HostError> {
        let worker = self
            .explorer
            .as_ref()
            .ok_or(HostError("explorer_owner_unavailable"))?;
        let mut observed = Vec::new();
        for message in self
            .expected
            .history
            .messages
            .iter()
            .filter(|row| row["nativeExplorerId"] == worker.lease.id)
        {
            for segment in message["segments"].as_array().into_iter().flatten() {
                let result = &segment["result"];
                let Some(call) = segment["toolCallId"].as_str() else {
                    continue;
                };
                if result["toolCallId"] != call || result["status"] != "success" {
                    continue;
                }
                let refs = collect_tool_result_evidence_refs(Some(call), result)
                    .map_err(|_| HostError("explorer_evidence_invalid"))?;
                for row in EvidenceIndexStore::new(&self.home).find(&refs, None)? {
                    if row["conversationId"] == self.identity.conversation_id
                        && row["streamId"] == self.identity.stream_id
                        && row["planId"] == worker.lease.plan
                        && row["toolCallId"] == call
                        && row["capabilityId"] == result["capabilityId"]
                    {
                        observed.extend(row["evidenceRef"].as_str().map(str::to_owned));
                    }
                }
            }
        }
        report(&worker.lease, worker.calls, content, observed)
    }
}

fn report(
    lease: &ExplorerLease,
    calls: usize,
    content: &str,
    actual: Vec<String>,
) -> Result<Value, HostError> {
    if actual.is_empty() {
        return Err(HostError("explorer_completed_without_tool_evidence"));
    }
    let allowed: BTreeSet<String> = actual.into_iter().collect();
    let parsed = decode_json_bounded(
        content.as_bytes(),
        JsonLimits {
            bytes: 32 * 1024,
            nodes: 1024,
            depth: 16,
            string_bytes: 16 * 1024,
        },
    )
    .map(|result| result.value)
    .unwrap_or_default();
    let refs = |v: &Value| {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|reference| allowed.contains(*reference))
            .map(str::to_owned)
            .collect::<BTreeSet<_>>()
    };
    let mut evidence = refs(&parsed["evidenceRefs"]);
    if evidence.is_empty() {
        evidence = allowed.clone();
    }
    let findings = parsed["findings"]
        .as_array()
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(|finding| {
            let proof = refs(&finding["evidenceRefs"]);
            let claim = text(&finding["claim"], 4096)?;
            (!proof.is_empty()).then(|| json!({"claim":claim,"evidenceRefs":proof}))
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"explorerId":lease.id,"planId":lease.plan,"question":lease.request["question"],
        "summary":text(&parsed["summary"],4096).unwrap_or("Explorer completed with tool evidence."),
        "findings":findings,"evidenceRefs":evidence,"toolEvidenceRefs":allowed,
        "recommendedNextStep":text(&parsed["recommendedNextStep"],4096),
        "confidence":parsed["confidence"].as_str().filter(|v|matches!(*v,"low"|"medium"|"high")).unwrap_or("medium"), "toolCallCount":calls}),
    )
}

fn text(value: &Value, max: usize) -> Option<&str> {
    value
        .as_str()
        .map(peer_protocol::javascript_trim)
        .filter(|s| !s.is_empty() && s.len() <= max)
}
