//! Canonical ordinary Plan approval persistence matching `goal-plan-store.mjs`.
use super::*;
use serde_json::json;

/// Decision recorded by the user on a pending `awaiting_approval` ordinary Plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanApprovalDecision {
    Approve,
    Revise,
    Reject,
}

impl GoalStore {
    /// Atomically record an approval decision on a local `awaiting_approval` Plan and
    /// update the `index.jsonl` status + `.changes.jsonl` notification journal.
    pub fn decide_ordinary_plan_approval(
        &self,
        plan_id: &str,
        expected_revision: &str,
        decision: PlanApprovalDecision,
        decided_by: &str,
        at: &str,
    ) -> Result<Value, GoalError> {
        if !valid_id(plan_id, false) {
            return Err(GoalError::Invalid);
        }
        let decided_by = match decided_by.trim() {
            "" => "user",
            trimmed => trimmed,
        };
        let transaction = explorer::PlanWrite::lock(self)?;
        let mut plan = self.read_context(plan_id, expected_revision)?;
        if !plan["delegationOrigin"].is_null()
            || plan["status"].as_str() != Some("awaiting_approval")
        {
            return Err(GoalError::Changed);
        }

        let (decision_str, next_status) = match decision {
            PlanApprovalDecision::Approve => ("approve", "approved"),
            PlanApprovalDecision::Revise => ("revise", "drafting"),
            PlanApprovalDecision::Reject => ("reject", "cancelled"),
        };

        plan["approval"] = json!({
            "decision": decision_str,
            "confirmationId": format!("plan-{}", uuid::Uuid::new_v4()),
            "decidedBy": decided_by,
            "decidedAt": at,
        });
        if matches!(decision, PlanApprovalDecision::Approve) {
            plan["activation"] = json!({ "kind": "approved_plan" });
        }
        plan["status"] = json!(next_status);
        plan["updatedAt"] = json!(at);

        transaction.publish(plan_id, expected_revision, &plan, at, || Ok(()))?;
        Ok(plan)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::durable_jsonl as log;

    struct ScopedPlanFacts;
    impl GoalFactProjector for ScopedPlanFacts {
        fn execution_facts(&self, body: &Value, _: Option<&Value>) -> Result<Value, &'static str> {
            let mut facts = body.clone();
            facts["active"] = json!(body["status"] != "cancelled");
            Ok(facts)
        }
    }

    fn seed_awaiting_plan(
        store: &GoalStore,
        workspace: &Path,
        plan_id: &str,
        conv_id: &str,
    ) -> String {
        let draft = OrdinaryGoalDraft::parse(
            &json!({
                "title": format!("Plan {plan_id}"),
                "goal": "Verify ordinary plan approval transition",
                "tasks": [{"taskId": "t1", "title": "Inspect"}]
            }),
            workspace,
        )
        .unwrap();
        let req = GoalPublication {
            plan_id,
            conversation: conv_id,
            workspace,
            kind: OrdinaryGoalKind::Plan,
            at: "2026-11-20T01:00:00Z",
        };
        store
            .publish_ordinary_goal(&draft, req, &ScopedPlanFacts, None, || Ok(()))
            .unwrap();
        store.revision(plan_id).unwrap()
    }

    #[test]
    fn decide_ordinary_plan_approval_transitions_status_and_updates_index() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path();
        let store = GoalStore::new(workspace);

        // 1. Approve -> status="approved", activation.kind="approved_plan", double decision -> Changed
        let rev_approve = seed_awaiting_plan(&store, workspace, "plan-approve", "conv-1");
        let approved = store
            .decide_ordinary_plan_approval(
                "plan-approve",
                &rev_approve,
                PlanApprovalDecision::Approve,
                "user",
                "2026-11-20T01:05:00Z",
            )
            .unwrap();
        assert_eq!(approved["status"], "approved");
        assert_eq!(approved["approval"]["decision"], "approve");
        assert_eq!(approved["approval"]["decidedBy"], "user");
        assert_eq!(approved["activation"]["kind"], "approved_plan");

        let next_rev = store.revision("plan-approve").unwrap();
        let err = store
            .decide_ordinary_plan_approval(
                "plan-approve",
                &next_rev,
                PlanApprovalDecision::Reject,
                "user",
                "2026-11-20T01:06:00Z",
            )
            .unwrap_err();
        assert_eq!(err, GoalError::Changed);

        // 2. Revise -> status="drafting"
        let rev_revise = seed_awaiting_plan(&store, workspace, "plan-revise", "conv-2");
        let revised = store
            .decide_ordinary_plan_approval(
                "plan-revise",
                &rev_revise,
                PlanApprovalDecision::Revise,
                "",
                "2026-11-20T01:07:00Z",
            )
            .unwrap();
        assert_eq!(revised["status"], "drafting");
        assert_eq!(revised["approval"]["decision"], "revise");
        assert_eq!(revised["approval"]["decidedBy"], "user");

        // 3. Reject -> status="cancelled", reflected in index.jsonl
        let rev_reject = seed_awaiting_plan(&store, workspace, "plan-reject", "conv-3");
        let rejected = store
            .decide_ordinary_plan_approval(
                "plan-reject",
                &rev_reject,
                PlanApprovalDecision::Reject,
                "reviewer",
                "2026-11-20T01:08:00Z",
            )
            .unwrap();
        assert_eq!(rejected["status"], "cancelled");
        assert_eq!(rejected["approval"]["decision"], "reject");

        let index_rows = log::read(&workspace.join("goal-plans/index.jsonl"), None).unwrap();
        let find_status = |id: &str| {
            index_rows
                .iter()
                .find(|r| r["planId"] == id)
                .and_then(|r| r["status"].as_str())
                .map(str::to_owned)
        };
        assert_eq!(find_status("plan-approve").as_deref(), Some("approved"));
        assert_eq!(find_status("plan-revise").as_deref(), Some("drafting"));
        assert_eq!(find_status("plan-reject").as_deref(), Some("cancelled"));
    }
}
