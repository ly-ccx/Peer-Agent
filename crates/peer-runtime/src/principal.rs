//! Permission-principal resolution over fresh host-owned plan facts.
//! Resolving an ancestor is neither a PermissionGrant nor execution admission.
use peer_protocol::javascript_trim;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionPrincipal {
    pub workspace_id: Option<String>,
    pub conversation_id: String,
}

/// Host projection of the existing GoalPlan's status / cancellation / phase.
/// Deliberately not Deserialize: arbitrary user/model JSON is not this fact source.
pub struct HostPlanPrincipalFacts {
    pub conversation_id: String,
    pub inheritance_stopped: bool,
    pub delegation: Option<HostDelegationPrincipalFacts>,
}
pub struct HostDelegationPrincipalFacts {
    pub workspace_id: String,
    pub session_id: String,
    pub parent_conversation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalError {
    FactsUnavailable,
    LimitExceeded,
}

/// The adapter must read canonical current plans, not profile-claimed ancestry.
pub trait PrincipalFactsSource {
    fn plan(&self, plan_id: &str) -> Result<Option<&HostPlanPrincipalFacts>, PrincipalError>;
    fn active_plan_by_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Option<&HostPlanPrincipalFacts>, PrincipalError>;
}
pub struct PrincipalQuery<'a> {
    pub workspace_id: Option<&'a str>,
    pub conversation_id: Option<&'a str>,
    pub plan_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
}
fn text(value: Option<&str>) -> Option<&str> {
    value.map(javascript_trim).filter(|text| !text.is_empty())
}

pub fn resolve_permission_principal(
    input: PrincipalQuery<'_>,
    source: &impl PrincipalFactsSource,
) -> Result<Option<PermissionPrincipal>, PrincipalError> {
    if [
        input.workspace_id,
        input.conversation_id,
        input.plan_id,
        input.session_id,
    ]
    .into_iter()
    .flatten()
    .any(|s| s.len() > 4096)
    {
        return Err(PrincipalError::LimitExceeded);
    }
    let workspace = text(input.workspace_id);
    let conversation = text(input.conversation_id);
    let principal = |conversation: &str| PermissionPrincipal {
        workspace_id: workspace.map(str::to_owned),
        conversation_id: conversation.to_owned(),
    };
    let Some(plan_id) = input.plan_id.filter(|id| !id.is_empty()) else {
        return Ok(conversation.map(principal));
    };
    let Some(plan) = source.plan(plan_id)? else {
        return Ok(None);
    };
    if plan.inheritance_stopped {
        return Ok(None);
    }
    let Some(origin) = &plan.delegation else {
        return Ok(conversation
            .filter(|c| workspace.is_some() && *c == plan.conversation_id)
            .map(principal));
    };
    if workspace.is_none()
        || workspace != Some(origin.workspace_id.as_str())
        || input.session_id.is_none_or(str::is_empty)
        || input.session_id != Some(origin.session_id.as_str())
        || conversation.is_some_and(|c| c != plan.conversation_id)
    {
        return Ok(None);
    }
    let mut parent = text(origin.parent_conversation_id.as_deref());
    for _ in 0..4 {
        let Some(id) = parent else {
            return Ok(None);
        };
        if id.len() > 4096 {
            return Err(PrincipalError::LimitExceeded);
        }
        let ancestor = source.active_plan_by_conversation(id)?;
        let Some(origin) = ancestor.and_then(|p| p.delegation.as_ref()) else {
            return Ok(Some(principal(id)));
        };
        if ancestor.is_some_and(|p| p.inheritance_stopped)
            || Some(origin.workspace_id.as_str()) != workspace
        {
            return Ok(None);
        }
        parent = text(origin.parent_conversation_id.as_deref());
    }
    Ok(None)
}
