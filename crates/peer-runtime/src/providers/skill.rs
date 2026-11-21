//! Mounted Skill results stay factual tool observations, even if the file
//! speaks in the imperative. The execution port owns permission.
use super::*;
use peer_store::{MountedSkill, SkillCatalog, SkillScope};
use std::sync::Arc;

pub(crate) const PREFIX: &str = "local.skill.";
const ALIAS: &str = "skill__";

pub fn skill_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && peer_protocol::javascript_trim(value) == value
        && !matches!(value, "." | "..")
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
}
pub fn wire_skill_name(value: &str) -> bool {
    value.strip_prefix(ALIAS).is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 57
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    })
}
fn wire_name(id: &str) -> String {
    let original = format!("{ALIAS}{id}");
    if wire_skill_name(&original) {
        return original;
    }
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(id.as_bytes()));
    let safe: String = id
        .chars()
        .take(40)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{ALIAS}{safe}_{}", &hash[..16])
}

pub(super) struct SkillProvider(pub Arc<SkillCatalog>);
impl CapabilityProvider for SkillProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        self.0.mounted.iter().map(|entry| {
            let m = &entry.manifest;
            let alias = wire_name(&m.id);
            let description = if m.when_to_use.is_empty() {
                m.description.clone()
            } else {
                format!("{}\n{}", m.description, m.when_to_use)
            };
            (alias, json!({
                "capabilityId": format!("{PREFIX}{}", m.id),
                "displayName": m.name,
                "description": description,
                "riskLevel": "L1_readonly",
                "modeScopes": ["chat", "plan", "goal"],
                "inputSchema": {
                    "type":"object","properties":{"userMessage":{"type":"string","description":"The user request that triggered this skill."}},
                    "additionalProperties":true
                }
            }))
        }).collect()
    }

    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        _workspace: &Path,
        _home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if !args.is_object()
            || serde_json::to_vec(&args)
                .map_err(|_| HostError("tool_arguments_invalid"))?
                .len()
                > 32 * 1024
        {
            return Err(HostError("tool_arguments_invalid"));
        }
        let id = capability
            .strip_prefix(PREFIX)
            .ok_or(HostError("tool_not_projected"))?;
        let index = self
            .0
            .mounted
            .iter()
            .position(|entry| entry.manifest.id == id)
            .ok_or(HostError("tool_not_projected"))?;
        Ok(Box::new(ReadSkill {
            catalog: self.0.clone(),
            index,
            args,
            port: None,
        }))
    }
}

struct ReadSkill {
    catalog: Arc<SkillCatalog>,
    index: usize,
    args: Value,
    port: Option<EffectAdmission>,
}
impl ReadSkill {
    fn selected(&self) -> &MountedSkill {
        &self.catalog.mounted[self.index]
    }
    fn observe(entry: &MountedSkill) -> Result<Value, HostError> {
        let directory = entry
            .directory
            .to_str()
            .ok_or(HostError("skill_path_invalid"))?;
        let raw = entry.instructions().map_err(|error| {
            HostError(if error == peer_store::StoreError::VersionChanged {
                "native_skill_source_changed"
            } else {
                "skill_load_failed"
            })
        })?;
        let instructions = expand_base_dir(&raw, directory)?;
        let m = &entry.manifest;
        let allowed = if m.allowed_tools.is_empty() {
            vec!["local_shell_exec"]
        } else {
            m.allowed_tools.iter().map(String::as_str).collect()
        };
        Ok(
            json!({"kind":"skill_instructions","skillId":m.id,"name":m.name,"version":m.version,
            "scope":if entry.scope == SkillScope::Workspace {"workspace"} else {"global"},
            "baseDir":directory,"allowedTools":allowed,"instructions":instructions}),
        )
    }
}

impl PreparedEffect for ReadSkill {
    fn args(&self) -> &Value {
        &self.args
    }

    fn permission(&self) -> ProviderPermission {
        ProviderPermission::Read
    }

    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }

    fn admission(&mut self, port: EffectAdmission) {
        self.port = Some(port);
    }

    fn evidence(&self) -> Option<Value> {
        let entry = self.selected();
        Some(
            json!({"skillId":entry.manifest.id,"skillName":entry.manifest.name,
            "skillVersion":entry.manifest.version,"baseDir":entry.directory,"dataLevel":entry.manifest.data_level}),
        )
    }

    fn start(
        mut self: Box<Self>,
        _call: ProviderCall,
        cancel: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        let port = self
            .port
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        Ok(Box::pin(async move {
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                let check = || -> Result<(), HostError> {
                    runtime.block_on(port.check())?;
                    self.catalog
                        .check_current()
                        .map_err(|_| HostError("native_skill_source_changed"))?;
                    if cancel.is_cancelled() {
                        return Err(HostError("CANCELLED"));
                    }
                    Ok(())
                };
                if let Err(error) = check() {
                    return EffectOutcome::not_dispatched(error.0);
                }
                match Self::observe(self.selected()).and_then(|output| {
                    check()?;
                    Ok(output)
                }) {
                    Ok(output) => EffectOutcome {
                        status: "success",
                        output,
                        error: None,
                        artifacts: vec![],
                        ended: true,
                        materialization: None,
                        not_dispatched: false,
                    },
                    Err(error) => {
                        let mut denied = EffectOutcome::failed(error.0);
                        if error.0 == "CANCELLED" {
                            denied.status = "cancelled";
                        }
                        denied
                    }
                }
            })
            .await
            .unwrap_or_else(|_| EffectOutcome::failed("skill_load_failed"))
        }))
    }
}

fn expand_base_dir(body: &str, base: &str) -> Result<String, HostError> {
    let mut parts = body.split("{baseDir}");
    let mut result = parts.next().unwrap_or_default().to_owned();
    for part in parts {
        if result.len() + base.len() + part.len() > 256 * 1024 {
            return Err(HostError("skill_result_limit"));
        }
        result.push_str(base);
        result.push_str(part);
    }
    Ok(result)
}
