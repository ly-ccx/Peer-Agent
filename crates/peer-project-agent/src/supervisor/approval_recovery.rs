//! Recover plan approvals from the current delegated plan, without replaying a user decision.
use super::*;

struct PendingPlanApproval<'a> {
    workspace_id: &'a str,
    approval_id: &'a str,
    plan_id: &'a str,
    session_id: &'a str,
    generation: &'a str,
    digest: String,
}

impl<'a> PendingPlanApproval<'a> {
    fn from_plan(plan: &'a Value) -> Option<Self> {
        let origin = &plan["delegationOrigin"];
        if plan["status"] != "awaiting_approval"
            || origin["phase"] != "awaiting_approval"
            || plan["workflowKind"] != "plan_approval"
            || !plan["approval"].is_null()
            || !origin["supersededBy"].is_null()
            || !origin["cancellation"].is_null()
        {
            return None;
        }
        let plan_id = plan["planId"].as_str()?;
        let session_id = origin["sessionId"].as_str()?;
        if plan["conversationId"] != session_id {
            return None;
        }
        Some(Self {
            workspace_id: origin["workspaceId"].as_str()?,
            approval_id: origin["planApprovalId"].as_str()?,
            plan_id,
            session_id,
            generation: origin["executionGeneration"].as_str()?,
            digest: format!("{:x}", Sha256::digest(plan_id.as_bytes())),
        })
    }

    fn matches(&self, row: &Value, approval_id: &str) -> bool {
        row["approvalId"] == approval_id
            && row["workspaceId"] == self.workspace_id
            && row["capabilityId"] == "goal.plan"
            && row["planId"] == self.plan_id
            && row["sessionId"] == self.session_id
            && row["conversationId"] == self.session_id
            && row["streamId"] == self.generation
            && row["argsDigest"] == self.digest
            && row["policyRevision"] == "1"
            && row["deadlineAt"].is_null()
    }

    fn recovery_id(&self) -> String {
        // Repeat recovery finds the same request if a prior host stopped after
        // appending the approval but before rebinding the plan to it.
        let prior = format!("{:x}", Sha256::digest(self.approval_id.as_bytes()));
        format!("plan:{}:recovery:{}", self.plan_id, &prior[..16])
    }
}

impl SessionSupervisor {
    pub(super) fn recover_workspace_approvals(
        &self,
        workspace_id: &str,
        plans: &mut [Value],
        at: &str,
    ) -> Result<(), ProjectError> {
        let _transition = self.transition_lock()?;
        let rows = self.approvals.list(Some(workspace_id), None)?;
        let rows_by_id: HashMap<&str, &Value> = rows
            .iter()
            .filter_map(|row| Some((row["approvalId"].as_str()?, row)))
            .collect();
        let mut preserve = HashSet::new();

        for plan in plans {
            let Some(binding) = PendingPlanApproval::from_plan(plan) else {
                continue;
            };
            let Some(previous) = rows_by_id
                .get(binding.approval_id)
                .filter(|row| binding.matches(row, binding.approval_id))
            else {
                continue;
            };

            if previous["state"] == "open" {
                preserve.insert(binding.approval_id.to_owned());
                continue;
            }
            // Older startup sweeps retired durable requests. The desktop sweep
            // omitted decidedBy, while the native sweep recorded policy.
            if previous["state"] != "stale"
                || !matches!(previous["decidedBy"].as_str(), None | Some("policy"))
                || !previous["decisionReason"].is_null()
            {
                continue;
            }

            let fresh_id = binding.recovery_id();
            if let Some(fresh) = rows_by_id.get(fresh_id.as_str()) {
                if fresh["state"] != "open" || !binding.matches(fresh, &fresh_id) {
                    continue;
                }
            } else {
                self.approvals.open(
                    &HostApproval {
                        approval_id: &fresh_id,
                        workspace_id: Some(workspace_id),
                        conversation_id: binding.session_id,
                        stream_id: binding.generation,
                        plan_id: Some(binding.plan_id),
                        session_id: Some(binding.session_id),
                        capability_id: "goal.plan",
                        args_digest: &binding.digest,
                        policy_revision: "1",
                        created_at: at,
                        deadline_at: None,
                    },
                    None,
                )?;
            }
            preserve.insert(fresh_id.clone());
            plan["delegationOrigin"]["planApprovalId"] = json!(fresh_id);
            plan["updatedAt"] = json!(at);
            self.write_plan(plan)?;
        }

        self.approvals
            .recover_owned_preserving(Some(workspace_id), at, None, |row| {
                row["approvalId"]
                    .as_str()
                    .is_some_and(|id| preserve.contains(id))
            })?;
        Ok(())
    }
}
