//! Explorer is a bounded read-only turn under the live ordinary Host owner.
use super::readonly_worker::WorkerLease;
use super::*;
use crate::providers::goal::explorer::{CAPABILITY, ExplorerRequest};
use peer_protocol::{JsonLimits, decode_json_bounded};
use peer_store::{
    AutomaticInspect, ExplorerDispatch, ExplorerLease, ExplorerSettlement, GoalStore,
    LocalGoalIntake,
};
use std::collections::BTreeSet;

pub(super) fn settled_parent_calls<'a>(
    history: &'a HistorySnapshot,
    stream: &'a str,
    capability: &'a str,
) -> impl Iterator<Item = (&'a str, &'a Value)> {
    history
        .history
        .messages
        .iter()
        .filter(move |message| message["streamId"] == stream && message["kind"] != "agent_activity")
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
            .filter(|(id, _)| !self.explorer_requests.contains(*id))
            .filter_map(|(id, segment)| {
                ExplorerRequest::parse(&segment["args"])
                    .ok()
                    .map(|request| (id.to_owned(), request))
            })
            .take(4)
            .collect::<Vec<_>>();
        if self.explorer_requests.len() + requests.len() > 3 {
            return Err(HostError("explorer_dispatch_limit"));
        }
        for (id, request) in requests {
            self.run_requested_explorer(&id, request, None).await?;
            self.explorer_requests.insert(id);
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
        let Some(lease) = store.begin_explorer(
            ExplorerDispatch {
                id,
                conversation: &self.identity.conversation_id,
                stream: &self.identity.stream_id,
                workspace: &self.workspace,
                request: &request,
                at: &now(),
                inspect,
                runner: self.runner.as_ref().map(|runner| &runner.lease),
            },
            &projector,
            || self.source_current().map_err(|err| err.0),
        )?
        else {
            // A registered request can await a real Goal and its approval.
            return Ok(None);
        };
        let mission = format!(
            "Explorer mission for plan \"{}\".\nQuestion: {}",
            lease.title,
            lease.request["question"]
                .as_str()
                .ok_or(HostError("explorer_request_invalid"))?
        );
        let work = self
            .run_readonly_worker(
                WorkerLease::Explorer(Box::new(lease)),
                &mission,
                Some(peer_store::EXPLORER_TOOL_LIMIT + 1),
            )
            .await;
        let result = work.and_then(|content| {
            let worker = self
                .worker
                .as_ref()
                .ok_or(HostError("explorer_owner_unavailable"))?;
            let WorkerLease::Explorer(lease) = &worker.lease else {
                return Err(HostError("explorer_owner_unavailable"));
            };
            report(lease, worker.calls, &content, self.worker_evidence(worker)?)
        });
        let worker = self
            .worker
            .as_ref()
            .ok_or(HostError("explorer_owner_unavailable"))?;
        let WorkerLease::Explorer(lease) = &worker.lease else {
            return Err(HostError("explorer_owner_unavailable"));
        };
        let failure = result.as_ref().err().copied();
        let settlement = match result {
            Ok(report) => ExplorerSettlement::Completed(report),
            Err(error) => ExplorerSettlement::Failed(error.0),
        };
        let next = store.finish_explorer(lease, settlement, &now(), || {
            self.check_worker_settled(failure.is_none())
                .map_err(|e| e.0)
        });
        self.worker = None;
        failure.map_or(Ok(next?), Err)
    }
}

fn report(
    lease: &ExplorerLease,
    calls: usize,
    content: &str,
    actual: BTreeSet<String>,
) -> Result<Value, HostError> {
    if actual.is_empty() {
        return Err(HostError("explorer_completed_without_tool_evidence"));
    }
    let allowed = actual;
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
