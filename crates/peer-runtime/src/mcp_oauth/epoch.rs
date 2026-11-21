//! Execution-local credential lineage. Only the OAuth publication owner advances it.
use peer_protocol::SessionExecutionIdentity;
use peer_store::{McpCredentialBinding, McpCredentialStore, McpRegistryStore};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub(crate) struct CredentialEpoch(Arc<Inner>);
struct Inner {
    home: PathBuf,
    execution: String,
    registry: String,
    initial: String,
    current: Mutex<String>,
}
impl CredentialEpoch {
    pub(crate) fn open(
        home: &Path,
        execution: &SessionExecutionIdentity,
        registry: &str,
    ) -> Result<Self, &'static str> {
        Self::open_principal(home, execution, registry)
    }
    pub(crate) fn open_conversation(
        home: &Path,
        execution: &peer_protocol::ConversationExecutionIdentity,
        registry: &str,
    ) -> Result<Self, &'static str> {
        Self::open_principal(home, execution, registry)
    }
    fn open_principal(
        home: &Path,
        execution: &impl crate::live_execution::LiveExecutionIdentity,
        registry: &str,
    ) -> Result<Self, &'static str> {
        let execution = execution
            .registry_key()
            .map_err(|_| "execution_identity_invalid")?;
        let revision = McpCredentialStore::new(home)
            .revision()
            .map_err(|e| e.code())?;
        Ok(Self(Arc::new(Inner {
            home: home.into(),
            execution,
            registry: registry.into(),
            initial: revision.clone(),
            current: Mutex::new(revision),
        })))
    }
    pub(crate) fn check(&self) -> Result<(), &'static str> {
        let current = self
            .0
            .current
            .lock()
            .map_err(|_| "mcp_credential_changed")?;
        if McpCredentialStore::new(&self.0.home)
            .revision()
            .map_err(|e| e.code())?
            != *current
        {
            return Err("mcp_credential_changed");
        }
        if McpRegistryStore::new(&self.0.home)
            .read()
            .map_err(|e| e.code())?
            .source_revision
            != self.0.registry
        {
            return Err("native_capability_inventory_changed");
        }
        Ok(())
    }
    pub(crate) fn normalized(
        &self,
        execution: &SessionExecutionIdentity,
    ) -> Result<Option<String>, &'static str> {
        if crate::live_execution::LiveExecutionIdentity::registry_key(execution)
            .ok()
            .as_ref()
            != Some(&self.0.execution)
        {
            return Ok(None);
        }
        self.check()?;
        Ok(Some(self.0.initial.clone()))
    }
    pub(crate) fn normalized_conversation(
        &self,
        execution: &peer_protocol::ConversationExecutionIdentity,
    ) -> Result<Option<String>, &'static str> {
        if crate::live_execution::LiveExecutionIdentity::registry_key(execution)
            .ok()
            .as_ref()
            != Some(&self.0.execution)
        {
            return Ok(None);
        }
        self.check()?;
        Ok(Some(self.0.initial.clone()))
    }
    pub(crate) fn binding(
        &self,
        config: &Value,
    ) -> Result<Option<McpCredentialBinding>, &'static str> {
        self.check()?;
        let binding = crate::mcp_auth::binding(&self.0.home, config)?;
        if let Some(binding) = &binding {
            let current = self
                .0
                .current
                .lock()
                .map_err(|_| "mcp_credential_changed")?;
            if binding.revision != *current {
                return Err("mcp_credential_changed");
            }
        }
        self.check()?;
        Ok(binding)
    }
    // Private to the parent OAuth Module: Providers cannot assert a publication.
    pub(super) fn published(
        &self,
        previous: &str,
        binding: &McpCredentialBinding,
    ) -> Result<(), &'static str> {
        let mut current = self
            .0
            .current
            .lock()
            .map_err(|_| "mcp_credential_changed")?;
        if *current != previous {
            return Err("mcp_credential_changed");
        }
        McpCredentialStore::new(&self.0.home)
            .check(binding)
            .map_err(|_| "mcp_credential_changed")?;
        if McpRegistryStore::new(&self.0.home)
            .read()
            .map_err(|e| e.code())?
            .source_revision
            != self.0.registry
        {
            return Err("native_capability_inventory_changed");
        }
        *current = binding.revision.clone();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_epoch_never_normalizes_as_goal_or_another_stream() {
        let root = tempfile::tempdir().unwrap();
        let ordinary = peer_protocol::ConversationExecutionIdentity {
            conversation_id: "c".into(),
            stream_id: "stream".into(),
        };
        let registry = McpRegistryStore::new(root.path())
            .read()
            .unwrap()
            .source_revision;
        let epoch = CredentialEpoch::open_conversation(root.path(), &ordinary, &registry).unwrap();
        assert!(epoch.normalized_conversation(&ordinary).unwrap().is_some());
        let other = peer_protocol::ConversationExecutionIdentity {
            stream_id: "other".into(),
            ..ordinary.clone()
        };
        assert!(epoch.normalized_conversation(&other).unwrap().is_none());
        let goal = peer_protocol::normalize_session_execution_identity(&serde_json::json!({"planId":"p","sessionId":"s","executionEpoch":"epoch","generation":"generation","goalRevision":2})).unwrap();
        assert!(epoch.normalized(&goal).unwrap().is_none());
        let goal_epoch = CredentialEpoch::open(root.path(), &goal, &registry).unwrap();
        assert!(goal_epoch.normalized(&goal).unwrap().is_some());
        assert!(
            goal_epoch
                .normalized_conversation(&ordinary)
                .unwrap()
                .is_none()
        );
    }
}
