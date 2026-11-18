//! Goal authority and billing Adapter for the shared native cognition pipeline.
use super::billing::BillingScope;
use super::{HostError, NativeSessionHost, episode_time as now};
use crate::cognition::CognitionHost;
use crate::{
    CancellationToken,
    execution_budget::EpisodeBudget,
    model::{ModelObservation, NativeModel},
    system_context::{assemble_work_context_for_turn, instructions::ProjectInstructions},
    usage_accounting::RuntimeUsageAccounting,
};
use serde_json::Value;
use std::path::Path;
pub(super) struct GoalRequestFrame<'a> {
    pub mcp_revision: &'a str,
    pub mcp_credentials: &'a crate::mcp_oauth::CredentialEpoch,
    pub plan: &'a str,
    pub goal_revision: &'a str,
    pub goal: &'a Value,
    pub workspace: &'a Path,
    pub instructions: &'a ProjectInstructions,
    pub budget: &'a EpisodeBudget,
    pub billing: &'a BillingScope<'a>,
    pub model: &'a NativeModel,
    pub tools: &'a Value,
    pub skills: &'a peer_store::SkillCatalog,
    pub skill_names: &'a [&'a str],
    pub owned: &'a CancellationToken,
    pub external: &'a CancellationToken,
}

pub(super) struct GoalCognitionHost<'a, 'f> {
    pub host: &'a mut NativeSessionHost,
    pub frame: &'a GoalRequestFrame<'f>,
}
impl CognitionHost for GoalCognitionHost<'_, '_> {
    fn authority(&self) -> Result<(), HostError> {
        let host = &*self.host;
        let f = self.frame;
        if peer_store::McpRegistryStore::new(&host.home)
            .read()?
            .source_revision
            != f.mcp_revision
        {
            return Err(HostError("native_capability_inventory_changed"));
        }
        f.mcp_credentials.check().map_err(HostError)?;
        crate::providers::require_migrated_hooks(&host.home, f.workspace)?;
        f.skills
            .check_current()
            .map_err(|_| HostError("native_skill_source_changed"))?;
        let fresh = host.current(f.plan, &now())?;
        if fresh.goal.source_revision != f.goal_revision {
            return Err(HostError("execution_revision_stale"));
        }
        let policy =
            peer_store::PolicyStore::new(&host.home).read_existing(&fresh.resource.workspace_id)?;
        if policy.conversation_id != f.goal["delegationOrigin"]["parentConversationId"] {
            return Err(HostError("out_of_scope"));
        }
        Ok(())
    }
    fn check_request(&self) -> Result<(), HostError> {
        self.frame.budget.check_request(self.host)
    }
    fn admit_request(&mut self, _capacity_bearing: bool) -> Result<(), HostError> {
        self.frame.budget.request(self.host, &now())
    }
    fn assemble(&self, continuity: &[Value]) -> Result<Value, HostError> {
        let f = self.frame;
        assemble_work_context_for_turn(
            f.workspace.to_str().ok_or(HostError("invalid_workspace"))?,
            f.model.provider(),
            f.model.model_id(),
            f.goal,
            &now(),
            f.instructions,
            (continuity, f.skill_names),
        )
        .map_err(HostError)
    }
    fn observe(
        &mut self,
        accounting: &mut RuntimeUsageAccounting,
        observed: ModelObservation,
        capacity_bearing: bool,
    ) -> Result<Option<peer_store::ConversationMetadataPublication>, HostError> {
        let f = self.frame;
        if capacity_bearing {
            self.host
                .observe_model_usage(f.budget, accounting, observed, f.billing)?;
        } else {
            self.host.observe_usage_for(
                f.budget,
                accounting,
                observed,
                f.billing,
                peer_protocol::UsagePurpose::CompactionSummary,
                false,
            )?;
        }
        Ok(None)
    }
    async fn wait<F: std::future::Future>(
        &mut self,
        future: F,
        owned: &CancellationToken,
        external: &CancellationToken,
    ) -> Result<F::Output, HostError> {
        self.host.wait_owned(future, owned, external).await
    }
}
