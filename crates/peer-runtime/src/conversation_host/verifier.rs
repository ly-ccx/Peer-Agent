//! An independent review uses the ordinary Host's read-only worker and the
//! version-bound Goal Store.
use super::{readonly_worker::WorkerLease, *};
use crate::system_context::verifier;
use peer_protocol::{JsonLimits, decode_json_bounded};
use peer_store::{GoalStore, OrdinaryRunner, VerifierReceipt, VerifierSettlement};

impl Host<'_> {
    pub(super) async fn run_goal_verifier(
        &mut self,
        store: &GoalStore,
        runner: &OrdinaryRunner,
        max_turns: Option<usize>,
    ) -> Result<(Option<VerifierReceipt>, usize), HostError> {
        let id = format!("verifier-{}", uuid::Uuid::new_v4());
        let Some(lease) = store.begin_verifier(runner, &id, &now(), || {
            self.source_current().map_err(|error| error.0)
        })?
        else {
            return Ok((None, 0));
        };
        let mission = verifier::mission(&lease);
        let work = self
            .run_readonly_worker(WorkerLease::Verifier(Box::new(lease)), &mission, max_turns)
            .await;
        let worker = self
            .worker
            .as_ref()
            .ok_or(HostError("goal_verifier_owner_unavailable"))?;
        let WorkerLease::Verifier(lease) = &worker.lease else {
            return Err(HostError("goal_verifier_owner_unavailable"));
        };
        let report = work.and_then(|content| {
            decode_report(&content, self.worker_evidence(worker)?, worker.calls)
        });
        let turns = worker.turns;
        let failure = report.as_ref().err().copied();
        let settlement = match report {
            Ok((report, explicitly_failed)) => VerifierSettlement::Report {
                report,
                allows_repair: explicitly_failed && !self.worker_was_denied(worker),
            },
            Err(reason) => VerifierSettlement::Interrupted(reason.0),
        };
        let saved = store.finish_verifier(lease, settlement, &now(), || {
            self.check_worker_settled(failure.is_none())
                .map_err(|error| error.0)
        });
        self.worker = None;
        let saved = saved?;
        failure.map_or(Ok((Some(saved), turns)), Err)
    }
}

fn bounded_text(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(peer_protocol::javascript_trim)
        .filter(|text| !text.is_empty() && text.len() <= 4096)
}

fn decode_report(
    content: &str,
    actual: BTreeSet<String>,
    calls: usize,
) -> Result<(Value, bool), HostError> {
    let invalid = HostError("goal_verifier_report_invalid");
    let parsed = decode_json_bounded(
        content.as_bytes(),
        JsonLimits {
            bytes: 32 * 1024,
            nodes: 2048,
            depth: 16,
            string_bytes: 24 * 1024,
        },
    )
    .map_err(|_| invalid)?
    .value;
    let claimed = parsed["passed"].as_bool().ok_or(invalid)?;
    let mut evidence = BTreeSet::new();
    let requested = parsed["evidenceRefs"].as_array().ok_or(invalid)?;
    let mut rejected = 0usize;
    for reference in requested {
        let reference = bounded_text(reference).ok_or(invalid)?;
        if actual.contains(reference) {
            evidence.insert(reference);
        } else {
            rejected += 1;
        }
    }
    let issues = |field: &str| -> Result<Vec<Value>, HostError> {
        let Some(values) = parsed.get(field) else {
            return Ok(vec![]);
        };
        let values = values
            .as_array()
            .filter(|items| items.len() <= 32)
            .ok_or(invalid)?;
        values
            .iter()
            .map(|value| {
                if let Some(text) = bounded_text(value) {
                    return Ok(json!(text));
                }
                let reason = bounded_text(&value["reason"]).ok_or(invalid)?;
                let references = value["evidenceRefs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(bounded_text)
                    .filter(|reference| actual.contains(*reference))
                    .collect::<BTreeSet<_>>();
                let mut issue = json!({"reason":reason,"evidenceRefs":references});
                for key in ["criterionId", "taskId"] {
                    if let Some(id) = bounded_text(&value[key]) {
                        issue[key] = json!(id);
                    }
                }
                Ok(issue)
            })
            .collect()
    };
    let failed = issues("failedCriteria")?;
    let missing = issues("missingEvidence")?;
    let risks = parsed["risks"]
        .as_array()
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(bounded_text)
        .collect::<Vec<_>>();
    let passed = claimed && !evidence.is_empty() && failed.is_empty() && missing.is_empty();
    let report = json!({"passed":passed,"failedCriteria":failed,"missingEvidence":missing,
        "summary":bounded_text(&parsed["summary"]).unwrap_or(if passed {"Verifier passed."} else {"Verifier found issues."}),
        "risks":risks,"evidenceRefs":evidence,"toolEvidenceRefs":actual,"rejectedReferenceCount":rejected,
        "recommendedNextAction":if passed {"complete"} else {"repair"},"toolCallCount":calls});
    Ok((report, !claimed))
}
