//! Mode and allowlist membership is decided before cognition and enforced again
//! by prepare's immutable projection lookup. Visibility is never permission.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeMode {
    Chat,
    Plan,
    Goal,
    Explorer,
    Compact,
    System,
    ProjectAgent,
    MemoryCurator,
}
impl RuntimeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Plan => "plan",
            Self::Goal => "goal",
            Self::Explorer => "explorer",
            Self::Compact => "compact",
            Self::System => "system",
            Self::ProjectAgent => "project_agent",
            Self::MemoryCurator => "memory_curator",
        }
    }
}
impl std::str::FromStr for RuntimeMode {
    type Err = HostError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "chat" => Ok(Self::Chat),
            "plan" => Ok(Self::Plan),
            "goal" => Ok(Self::Goal),
            "explorer" => Ok(Self::Explorer),
            "compact" => Ok(Self::Compact),
            "system" => Ok(Self::System),
            "project_agent" => Ok(Self::ProjectAgent),
            "memory_curator" => Ok(Self::MemoryCurator),
            _ => Err(HostError("runtime_mode_invalid")),
        }
    }
}
fn available(manifest: &Value, mode: RuntimeMode) -> Result<bool, HostError> {
    let scopes = match manifest.get("modeScopes") {
        None => &[][..],
        Some(Value::Array(scopes))
            if scopes.iter().all(|v| {
                v.as_str()
                    .is_some_and(|s| !peer_protocol::javascript_trim(s).is_empty())
            }) =>
        {
            scopes.as_slice()
        }
        _ => return Err(HostError("manifest_invalid")),
    };
    if scopes.is_empty() {
        return Ok(matches!(
            mode,
            RuntimeMode::Chat | RuntimeMode::Plan | RuntimeMode::Goal
        ));
    }
    Ok(scopes.iter().any(|s| s == mode.as_str()))
}
impl RuntimeProjection {
    pub(super) fn restrict(
        mut self,
        mode: RuntimeMode,
        allowlist: Option<&[String]>,
    ) -> Result<Self, HostError> {
        // Validate every manifest, including excluded definitions. A malformed
        // optional scope cannot silently acquire unscoped fallback behavior.
        let mut selected = Vec::with_capacity(self.tools.len());
        for tool in self.tools {
            if available(&tool.manifest, mode)?
                && allowlist.is_none_or(|ids| ids.contains(&tool.capability))
            {
                selected.push(tool);
            }
        }
        self.tools = selected;
        self.id = peer_protocol::javascript_json_digest(&json!(
            self.tools.iter().map(|t| &t.manifest).collect::<Vec<_>>()
        ))
        .map_err(|_| HostError("projection_limit"))?;
        Ok(self)
    }
}

#[cfg(test)]
mod tests;
