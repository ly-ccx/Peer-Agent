//! Work-session capability profile intersections and Independent Read-Only Verifier
//! (`packages/runtime-node/src/project-agent/work-session-profile.mjs`,
//! `verifier-report.mjs`, `verifier-lifecycle.mjs`, ADR 80 / ADR 88 / ADR 103).

use crate::{
    BotCapabilityPolicy, INTERACTIVE_INSPECT_CAPABILITY, INTERACTIVE_INSPECT_TOOL,
    InteractiveContentBridge, ProjectError, WorkSessionInteractiveContext,
    WorkSessionInteractiveProvider, interactive_context_extension, now_iso,
};
use peer_protocol::{
    LocalAccessLevel,
    interactive_result::{
        INTERACTIVE_PUBLISH_CAPABILITY, INTERACTIVE_PUBLISH_TOOL, INTERACTIVE_RESULT_PREFIX,
        InteractiveOwner,
    },
};
use peer_runtime::{
    CancellationToken,
    conversation_host::{ConversationAccess, ConversationOptions, NativeConversationRuntime},
    model::NativeModel,
    providers::{CapabilityProvider, RuntimeMode},
    session_host::{LocalPermissionDecision, PermissionInput},
};
use peer_store::{EvidenceIndexStore, McpRegistryStore, PolicyStore, SkillCatalog};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

const MAX_VERIFIER_TEXT: usize = 100_000;
const MAX_REPAIR_TEXT: usize = 4_000;

pub const WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES: [&str; 4] = [
    "local.web.control.",
    "local.delegation.",
    "local.objective.",
    "local.memory.",
];

pub const READ_ONLY_CAPABILITY_CEILING: [&str; 6] = [
    "local.file.read",
    "local.file.list",
    "local.file.search",
    "local.git.query",
    "local.search.aggregate",
    "local.tool-result.read",
];

pub const WORKER_CAPABILITY_CEILING: [&str; 12] = [
    "local.file.read",
    "local.file.list",
    "local.file.search",
    "local.git.query",
    "local.search.aggregate",
    "local.tool-result.read",
    "local.file.write",
    "local.file.edit",
    "local.shell.exec",
    "local.shell.stop",
    "local.web.fetch",
    "local.web.search",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkSessionProfile {
    pub agent_kind: String,
    pub read_only: bool,
    pub allowlist: Vec<String>,
    pub exclude_prefixes: Vec<&'static str>,
}

fn access_error(error: peer_store::StoreError) -> ProjectError {
    ProjectError::code(match error {
        peer_store::StoreError::OutOfScope
        | peer_store::StoreError::NotFound
        | peer_store::StoreError::InvalidInput => "access_identity_invalid",
        _ => "access_policy_unavailable",
    })
}

/// The access of a session delegated by a Bot. It is the policy the Bot's own
/// access control shows: the first appearance of a Bot starts at Ask, and every
/// later call re-reads the saved level. A policy that cannot be read, or that
/// belongs to another Bot conversation, is a structured rejection; no other
/// level is substituted for it (ADR101 §2.3, §4.3, §6.3).
pub(crate) fn delegated_access(
    data_home: &Path,
    workspace_id: &str,
) -> Result<ConversationAccess, ProjectError> {
    let store = PolicyStore::new(data_home);
    let at = now_iso();
    if !data_home
        .join("project-runtime")
        .join("bot-access.sqlite")
        .exists()
    {
        store
            .initialize(LocalAccessLevel::AskBeforeLocal, &at, None)
            .map_err(access_error)?;
    }
    store
        .read_or_register(workspace_id, &at)
        .map_err(access_error)?;
    ConversationAccess::for_bot(data_home, workspace_id)
        .map_err(|error| ProjectError::code(error.0))
}

fn is_excluded_capability(cap: &str) -> bool {
    WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES
        .iter()
        .any(|prefix| cap.starts_with(prefix))
}

pub(crate) fn expand_requested_capabilities(raw: &str) -> Vec<&'static str> {
    let key = raw.trim().to_ascii_lowercase();
    if key.is_empty() || is_excluded_capability(&key) {
        return Vec::new();
    }
    match key.as_str() {
        "local.file.read" | "read_file" | "read_files" | "file-read" | "file_read" | "read" => {
            vec!["local.file.read"]
        }
        "local.file.list" | "list_files" | "list_directory" | "file-list" | "file_list" => {
            vec!["local.file.list"]
        }
        "local.file.search" | "search_files" | "search" | "file-search" | "file_search"
        | "grep" | "rg" => {
            vec!["local.file.search", "local.search.aggregate"]
        }
        "local.search.aggregate" | "batch_search" => {
            vec!["local.search.aggregate", "local.file.search"]
        }
        "local.git.query" | "git_query" | "git" | "git-read" | "git_read" => {
            vec!["local.git.query"]
        }
        "local.tool-result.read" | "read_tool_result" => vec!["local.tool-result.read"],
        "local.file.write" | "local.file.edit" | "file-write" | "file_write" | "file-edit"
        | "file_edit" | "write_file" | "edit_file" | "write" | "edit" | "filesystem" | "fs" => {
            vec!["local.file.write", "local.file.edit"]
        }
        "local.shell.exec" | "local.shell.stop" | "local.shell" | "shell" | "bash" | "command"
        | "exec" | "terminal" | "run_command" => {
            vec!["local.shell.exec", "local.shell.stop"]
        }
        "local.web.fetch" | "web_fetch" | "web-fetch" | "fetch" => {
            vec!["local.web.fetch"]
        }
        "local.web.search" | "web_search" | "web-search" | "search_web" | "internet_search" => {
            vec!["local.web.search"]
        }
        "web_research" | "web" => {
            vec!["local.web.search", "local.web.fetch"]
        }
        "local.interactive.publish" | "publish_interactive_result" => {
            vec![
                INTERACTIVE_PUBLISH_CAPABILITY,
                INTERACTIVE_INSPECT_CAPABILITY,
            ]
        }
        "local.interactive.inspect" | "inspect_interactive_result" => {
            vec![INTERACTIVE_INSPECT_CAPABILITY]
        }
        _ => Vec::new(),
    }
}

/// Computes the governed capability profile for a delegated work-session role
/// (`"worker"`, `"explorer"`, `"verifier"`). Intersects requested capabilities
/// against strict role ceilings and never admits control/delegation/write caps
/// in read-only roles (except the ADR 118 §9.1 internal interactive publication
/// exception when `interactive_enabled` is true for `"worker"`).
///
/// The profile decides which capabilities a role may use. Whether an admitted
/// call needs user approval is the Bot's current policy, read by the Host at
/// execution time; no access level is copied here (ADR101 §2.3, §2.5, §2.6).
pub fn resolve_work_session_profile(plan: &Value, agent_kind: &str) -> Option<WorkSessionProfile> {
    resolve_work_session_profile_with_interactive(plan, agent_kind, false)
}

pub fn resolve_work_session_profile_with_interactive(
    plan: &Value,
    agent_kind: &str,
    interactive_enabled: bool,
) -> Option<WorkSessionProfile> {
    let origin = plan["delegationOrigin"].as_object()?;
    let read_only_origin = origin
        .get("readOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let read_only = matches!(agent_kind, "verifier" | "explorer") || read_only_origin;

    let ceiling: &[&str] = if read_only {
        &READ_ONLY_CAPABILITY_CEILING
    } else {
        &WORKER_CAPABILITY_CEILING
    };
    let mut requested_interactive_publish = false;
    let mut requested_interactive_inspect = false;
    let mut requested_web_fetch = false;
    let mut requested_web_search = false;
    let requested: Vec<String> = origin
        .get("requiredCapabilities")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .flat_map(expand_requested_capabilities)
        .filter(|c| !is_excluded_capability(c))
        .filter(|c| {
            if *c == INTERACTIVE_PUBLISH_CAPABILITY {
                requested_interactive_publish = true;
                return false;
            }
            if *c == INTERACTIVE_INSPECT_CAPABILITY {
                requested_interactive_inspect = true;
                return false;
            }
            if *c == "local.web.fetch" {
                requested_web_fetch = true;
                return !read_only;
            }
            if *c == "local.web.search" {
                requested_web_search = true;
                return !read_only;
            }
            ceiling.contains(c)
        })
        .map(str::to_owned)
        .collect();

    let mut allowlist = Vec::new();
    let mut seen = HashSet::new();
    let push_unique = |item: String, list: &mut Vec<String>, set: &mut HashSet<String>| {
        if set.insert(item.clone()) {
            list.push(item);
        }
    };

    if read_only {
        if requested.is_empty() {
            for &cap in &READ_ONLY_CAPABILITY_CEILING {
                push_unique(cap.to_owned(), &mut allowlist, &mut seen);
            }
        } else {
            for cap in requested {
                push_unique(cap, &mut allowlist, &mut seen);
            }
            push_unique(
                "local.tool-result.read".to_owned(),
                &mut allowlist,
                &mut seen,
            );
        }
    } else {
        for &cap in &READ_ONLY_CAPABILITY_CEILING {
            push_unique(cap.to_owned(), &mut allowlist, &mut seen);
        }
        for cap in requested {
            push_unique(cap, &mut allowlist, &mut seen);
        }
        let needs_shell = plan["successCriteria"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|c| matches!(c["kind"].as_str(), Some("command" | "test")));
        if needs_shell {
            push_unique("local.shell.exec".to_owned(), &mut allowlist, &mut seen);
            push_unique("local.shell.stop".to_owned(), &mut allowlist, &mut seen);
        }
        let has_write_or_shell = allowlist.iter().any(|cap| {
            matches!(
                cap.as_str(),
                "local.file.write" | "local.file.edit" | "local.shell.exec"
            )
        });
        if !has_write_or_shell {
            for &cap in &WORKER_CAPABILITY_CEILING {
                push_unique(cap.to_owned(), &mut allowlist, &mut seen);
            }
        }
    }

    // Read-only web research workers may explicitly request `local.web.search`
    // and/or `local.web.fetch` (read-only HTTP only; writes, shell, and
    // `local.web.control.*` remain forbidden). Independent verifiers, explorers,
    // and default read-only workers never receive either web capability.
    if agent_kind == "worker" {
        if requested_web_search {
            push_unique("local.web.search".to_owned(), &mut allowlist, &mut seen);
        }
        if requested_web_fetch {
            push_unique("local.web.fetch".to_owned(), &mut allowlist, &mut seen);
        }
    }

    // ADR 118 §9.1: When interactive results are enabled on Desktop, workers (including
    // readOnly workers) receive `local.interactive.publish` + `local.interactive.inspect`,
    // whereas verifiers receive `local.interactive.inspect` ONLY (never publish).
    if interactive_enabled {
        match agent_kind {
            "worker" => {
                if requested_interactive_publish || requested_interactive_inspect || !read_only {
                    push_unique(
                        INTERACTIVE_PUBLISH_CAPABILITY.to_owned(),
                        &mut allowlist,
                        &mut seen,
                    );
                    push_unique(
                        INTERACTIVE_INSPECT_CAPABILITY.to_owned(),
                        &mut allowlist,
                        &mut seen,
                    );
                }
            }
            "verifier" | "visual_verifier" => {
                push_unique(
                    INTERACTIVE_INSPECT_CAPABILITY.to_owned(),
                    &mut allowlist,
                    &mut seen,
                );
            }
            _ => {}
        }
    }

    let _ = (INTERACTIVE_PUBLISH_TOOL, INTERACTIVE_INSPECT_TOOL);

    Some(WorkSessionProfile {
        agent_kind: agent_kind.to_owned(),
        read_only,
        allowlist,
        exclude_prefixes: WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES.to_vec(),
    })
}

fn is_read_only_mcp_risk(risk_level: Option<&str>) -> bool {
    matches!(
        risk_level,
        Some("L0_inert" | "L1_local_read" | "L1_readonly")
    )
}

/// Extends a delegated `"worker"` work-session profile's allowlist with the
/// parent Bot's mounted Skills (`local.skill.*`) and MCP tools (`local.mcp.*`).
/// Independent `"verifier"` / `"explorer"` roles remain strictly restricted to
/// `READ_ONLY_CAPABILITY_CEILING`. Read-only worker tasks receive all mounted
/// Skills (L1_readonly) plus read-only MCP tools only.
pub fn extend_worker_allowlist_with_bot_capabilities(
    data_home: &Path,
    workspace: &Path,
    policy: Option<&BotCapabilityPolicy>,
    profile: &mut WorkSessionProfile,
) {
    if profile.agent_kind != "worker" {
        return;
    }
    let empty: Vec<String> = Vec::new();
    let enabled_skills = policy.map_or(empty.as_slice(), |p| p.enabled_skill_ids.as_slice());
    let disabled_skills = policy.map_or(empty.as_slice(), |p| p.disabled_skill_ids.as_slice());
    let enabled_mcps = policy.map_or(empty.as_slice(), |p| p.enabled_mcp_ids.as_slice());
    let disabled_mcps = policy.map_or(empty.as_slice(), |p| p.disabled_mcp_ids.as_slice());

    let mut seen: HashSet<String> = profile.allowlist.iter().cloned().collect();

    if let Ok(catalog) =
        SkillCatalog::observe_with_overrides(data_home, workspace, enabled_skills, disabled_skills)
    {
        for skill in catalog.mounted {
            let cap_id = format!("local.skill.{}", skill.manifest.id);
            if !is_excluded_capability(&cap_id) && seen.insert(cap_id.clone()) {
                profile.allowlist.push(cap_id);
            }
        }
    }

    if let Ok(snapshot) =
        McpRegistryStore::new(data_home).read_with_overrides(enabled_mcps, disabled_mcps)
    {
        for manifest in &snapshot.inventory.manifests {
            let Some(cap_id) = manifest["capabilityId"].as_str() else {
                continue;
            };
            if is_excluded_capability(cap_id) {
                continue;
            }
            if profile.read_only && !is_read_only_mcp_risk(manifest["riskLevel"].as_str()) {
                continue;
            }
            if seen.insert(cap_id.to_owned()) {
                profile.allowlist.push(cap_id.to_owned());
            }
        }
    }
}

/// Builds a concise factual summary of this Bot's mounted Skills & MCP services
/// for `L4_CAPABILITIES` in the project-agent system context, so the Bot knows
/// which mounted capabilities all delegated child work sessions automatically inherit.
pub fn render_bot_mounted_capabilities_summary(
    data_home: &Path,
    workspace: &Path,
    policy: Option<&BotCapabilityPolicy>,
) -> Option<String> {
    let empty: Vec<String> = Vec::new();
    let enabled_skills = policy.map_or(empty.as_slice(), |p| p.enabled_skill_ids.as_slice());
    let disabled_skills = policy.map_or(empty.as_slice(), |p| p.disabled_skill_ids.as_slice());
    let enabled_mcps = policy.map_or(empty.as_slice(), |p| p.enabled_mcp_ids.as_slice());
    let disabled_mcps = policy.map_or(empty.as_slice(), |p| p.disabled_mcp_ids.as_slice());

    let mut skill_lines = Vec::new();
    if let Ok(catalog) =
        SkillCatalog::observe_with_overrides(data_home, workspace, enabled_skills, disabled_skills)
    {
        for entry in catalog.mounted.iter().take(24) {
            let m = &entry.manifest;
            let desc: String = m.description.trim().chars().take(120).collect();
            if desc.is_empty() {
                skill_lines.push(format!("  - {} ({})", m.id, m.name));
            } else {
                skill_lines.push(format!("  - {} ({}): {}", m.id, m.name, desc));
            }
        }
    }

    let mut mcp_groups: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    if let Ok(snapshot) =
        McpRegistryStore::new(data_home).read_with_overrides(enabled_mcps, disabled_mcps)
    {
        for manifest in &snapshot.inventory.manifests {
            let provider_id = manifest["providerId"].as_str().unwrap_or("").trim();
            if provider_id.is_empty() {
                continue;
            }
            let provider_label = manifest["providerLabel"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(provider_id);
            let tool_name = manifest["origin"]["toolName"]
                .as_str()
                .or_else(|| manifest["name"].as_str())
                .unwrap_or("");
            let entry = mcp_groups
                .entry(provider_id.to_owned())
                .or_insert_with(|| (provider_label.to_owned(), Vec::new()));
            if !tool_name.is_empty() && entry.1.len() < 12 {
                entry.1.push(tool_name.to_owned());
            }
        }
    }

    if skill_lines.is_empty() && mcp_groups.is_empty() {
        return None;
    }

    let mut out = String::from(
        "Bot Mounted Capabilities (shared and automatically inherited by all child tasks spawned by this Bot):\n",
    );
    if !skill_lines.is_empty() {
        out.push_str(&format!("- Mounted Skills ({}):\n", skill_lines.len()));
        for line in &skill_lines {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !mcp_groups.is_empty() {
        out.push_str(&format!("- Mounted MCP Services ({}):\n", mcp_groups.len()));
        for (provider_id, (label, tools)) in mcp_groups.iter().take(16) {
            let tools_preview = if tools.is_empty() {
                "no visible tools".to_owned()
            } else {
                tools.join(", ")
            };
            out.push_str(&format!(
                "  - {} ({}): {}\n",
                label, provider_id, tools_preview
            ));
        }
    }
    out.push_str(
        "When delegating tasks via `spawn_session`, child workers automatically share these mounted Skills and MCP tools (read-only tasks receive Skills and read-only MCP tools only). Reference relevant Skills or MCP services in the task brief when useful.",
    );
    Some(out)
}

pub fn model_family(model_id: &str) -> String {
    let lower = model_id.trim().to_lowercase();
    let stripped = lower.rsplit('/').next().unwrap_or(&lower).trim();
    for prefix in [
        "claude", "gpt", "o1", "o3", "o4", "gemini", "deepseek", "qwen", "glm", "kimi", "llama",
        "mistral",
    ] {
        if stripped.starts_with(prefix) {
            return prefix.to_owned();
        }
    }
    stripped
        .split(['-', '_', ':', '.'])
        .find(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifierIssue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criterion_id: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifierReport {
    pub passed: bool,
    #[serde(default)]
    pub failed_criteria: Vec<VerifierIssue>,
    #[serde(default)]
    pub missing_evidence: Vec<VerifierIssue>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_next_action: Option<String>,
}

#[derive(Debug, Clone)]
pub enum VerifierOutcome {
    Verified {
        report: VerifierReport,
        verifier_conversation_id: String,
        verifier_model_id: String,
        same_family_as_worker: bool,
        verifier_evidence_refs: Vec<String>,
    },
    InvalidReport {
        error: &'static str,
        summary: String,
        verifier_conversation_id: String,
    },
}

fn extract_balanced_top_level_objects(text: &str) -> Option<Vec<Value>> {
    let mut objects = Vec::new();
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_quotes = false;
    let mut escaped = false;

    for (idx, ch) in text.char_indices() {
        if start.is_none() {
            if ch == '{' {
                start = Some(idx);
                depth = 1;
            }
            continue;
        }
        if in_quotes {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_quotes = false;
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0
                && let Some(s) = start.take()
            {
                let parsed = serde_json::from_str::<Value>(&text[s..=idx]).ok()?;
                objects.push(parsed);
            }
        }
    }
    if start.is_some() {
        return None;
    }
    Some(objects)
}

fn clean_string_list(val: Option<&Value>) -> Option<Vec<String>> {
    let Some(v) = val else {
        return Some(Vec::new());
    };
    let arr = v.as_array()?;
    let mut out = Vec::new();
    for item in arr {
        let s = item.as_str()?.trim();
        if !s.is_empty() {
            out.push(s.to_owned());
        }
    }
    Some(out)
}

fn clean_issue_list(val: Option<&Value>) -> Option<Vec<VerifierIssue>> {
    let Some(v) = val else {
        return Some(Vec::new());
    };
    let arr = v.as_array()?;
    let mut out = Vec::new();
    for item in arr {
        if let Some(raw) = item.as_str() {
            let reason = raw.trim();
            if reason.is_empty() {
                return None;
            }
            out.push(VerifierIssue {
                task_id: None,
                criterion_id: None,
                reason: reason.to_owned(),
                evidence_refs: Vec::new(),
            });
            continue;
        }
        let obj = item.as_object()?;
        let reason = obj.get("reason").and_then(Value::as_str)?.trim();
        if reason.is_empty() {
            return None;
        }
        let task_id = match obj.get("taskId") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            _ => return None,
        };
        let criterion_id = match obj.get("criterionId") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            _ => return None,
        };
        let evidence_refs = clean_string_list(obj.get("evidenceRefs"))?;
        out.push(VerifierIssue {
            task_id,
            criterion_id,
            reason: reason.to_owned(),
            evidence_refs,
        });
    }
    Some(out)
}

/// Decodes a structured JSON verifier report matching `verifier-report.mjs#decodeVerifierReport`.
pub fn decode_verifier_report(text: &str) -> Option<VerifierReport> {
    let trimmed = text.trim();
    if trimmed.is_empty() || text.chars().count() > MAX_VERIFIER_TEXT {
        return None;
    }
    let candidates = match serde_json::from_str::<Value>(trimmed) {
        Ok(val) => vec![val],
        Err(_) => extract_balanced_top_level_objects(text)?,
    };
    if candidates.len() != 1 {
        return None;
    }
    let report = candidates.into_iter().next()?;
    let obj = report.as_object()?;
    let passed = obj.get("passed").and_then(Value::as_bool)?;
    let failed_criteria = clean_issue_list(obj.get("failedCriteria"))?;
    let missing_evidence = clean_issue_list(obj.get("missingEvidence"))?;
    let risks = clean_string_list(obj.get("risks"))?;
    let evidence_refs = clean_string_list(obj.get("evidenceRefs"))?;
    if passed && evidence_refs.is_empty() {
        return None;
    }
    let summary = match obj.get("summary") {
        None | Some(Value::Null) => {
            if passed {
                "Verifier passed.".to_owned()
            } else {
                "Verifier found issues.".to_owned()
            }
        }
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                if passed {
                    "Verifier passed.".to_owned()
                } else {
                    "Verifier found issues.".to_owned()
                }
            } else {
                t.to_owned()
            }
        }
        _ => return None,
    };
    let recommended_next_action = match obj.get("recommendedNextAction") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_owned())
        }
        _ => return None,
    };

    Some(VerifierReport {
        passed,
        failed_criteria,
        missing_evidence,
        risks,
        evidence_refs,
        summary,
        recommended_next_action,
    })
}

struct DenyEscalationPermission;

/// Returns `true` only for read-only `local.git.query` requests reading standard
/// system/user Git config, ignore, or attributes files (e.g. macOS
/// `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig` or `~/.gitconfig`).
/// All write/shell/web escalations and arbitrary outside-workspace file reads remain denied.
fn is_safe_verifier_git_config_read(prompt: &Value) -> bool {
    if prompt["capabilityId"].as_str() != Some("local.git.query")
        || prompt["riskLevel"].as_str() != Some("L1_local_read")
    {
        return false;
    }
    let Some(scopes) = prompt["scopes"].as_array() else {
        return false;
    };
    if scopes.is_empty() {
        return false;
    }
    scopes.iter().all(|scope| {
        if scope["kind"].as_str() != Some("file-read")
            || scope["capabilityId"].as_str() != Some("local.git.query")
        {
            return false;
        }
        let Some(raw_path) = scope["path"].as_str().map(str::trim) else {
            return false;
        };
        let normalized = raw_path.replace('\\', "/");
        let lower = normalized.to_ascii_lowercase();
        let file_name = Path::new(&normalized)
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        matches!(
            file_name.as_str(),
            "gitconfig" | ".gitconfig" | ".gitignore" | ".gitattributes"
        ) || lower.ends_with("/git/config")
            || lower.ends_with("/git/ignore")
            || lower.ends_with("/git/attributes")
            || lower.ends_with("/git-core/gitconfig")
            || lower.ends_with("/git-core/attributes")
    })
}

impl PermissionInput for DenyEscalationPermission {
    fn decide<'a>(
        &'a mut self,
        prompt: Value,
        _cancel: &'a CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = LocalPermissionDecision> + 'a>> {
        let decision = if is_safe_verifier_git_config_read(&prompt) {
            LocalPermissionDecision::Approve
        } else {
            LocalPermissionDecision::Deny
        };
        Box::pin(async move { decision })
    }
}

const MAX_REPAIR_REFS_LISTED: usize = 200;

enum RepairFeedback {
    InvalidFormat {
        previous_text: String,
    },
    UnindexedRefs {
        unindexed_refs: Vec<String>,
        previous_text: String,
    },
}

fn collect_conversation_evidence_refs(
    evidence_store: &EvidenceIndexStore,
    conversation_id: &str,
    allowed_refs: &mut HashSet<String>,
    verifier_ev_refs: &mut Vec<String>,
) {
    if conversation_id.is_empty() {
        return;
    }
    if let Ok(rows) = evidence_store.list_for_conversation(conversation_id, None) {
        for row in rows {
            if let Some(r) = row["evidenceRef"].as_str().map(str::trim)
                && !r.is_empty()
            {
                let owned = r.to_owned();
                allowed_refs.insert(owned.clone());
                if !verifier_ev_refs.contains(&owned) {
                    verifier_ev_refs.push(owned);
                }
            }
        }
    }
}

fn prioritized_allowed_refs(
    verifier_ev_refs: &[String],
    allowed_refs: &HashSet<String>,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for r in verifier_ev_refs {
        if seen.insert(r.as_str()) {
            out.push(r.clone());
            if out.len() >= MAX_REPAIR_REFS_LISTED {
                return out;
            }
        }
    }
    let mut rest: Vec<&str> = allowed_refs
        .iter()
        .map(String::as_str)
        .filter(|r| !seen.contains(*r))
        .collect();
    rest.sort();
    for r in rest {
        out.push(r.to_owned());
        if out.len() >= MAX_REPAIR_REFS_LISTED {
            break;
        }
    }
    out
}

fn build_verifier_prompt(
    plan: &Value,
    allowed_refs: &HashSet<String>,
    focus: Option<&str>,
) -> String {
    let title = plan["title"].as_str().unwrap_or("");
    let goal = plan["goal"].as_str().unwrap_or("");
    let worker_output = plan["delegationOrigin"]["lastWorkerOutput"]
        .as_str()
        .unwrap_or("");
    let criteria_json =
        serde_json::to_string(&plan["successCriteria"]).unwrap_or_else(|_| "[]".into());
    let mut known_list: Vec<&str> = allowed_refs.iter().map(String::as_str).collect();
    known_list.sort();
    let known_json = serde_json::to_string(&known_list).unwrap_or_else(|_| "[]".into());

    let focus = focus.map(|text| {
        format!("\nAdditional review question (within the existing criteria and read-only permissions): {text}\n")
    }).unwrap_or_default();

    let interactive_hint = if allowed_refs
        .iter()
        .any(|r| r.starts_with(INTERACTIVE_RESULT_PREFIX))
    {
        "\nInteractive Results Verification:\n\
         - Published interactive results (`interactive-result://<workspaceId>/<conversationId>/<resultId>/<sha256>`) are listed in `Known Worker Evidence Refs`.\n\
         - Use `inspect_interactive_result` (`view: \"metadata\" | \"program\" | \"data\" | \"evaluate\"`) to verify the actual OpenUI program, bindings, and evaluated output rather than trusting worker prose.\n\
         - Copy the exact `interactive-result://...` locator into `evidenceRefs` when passing.\n"
    } else {
        ""
    };

    format!(
        "You are an independent read-only Verification Reviewer.\n\
         Verify the completed delegated session strictly against persisted disk state and indexed host Evidence.\n\
         Never modify files or assume worker prose is true without verifying.\n\
         Verify changed workspace files and git state directly via git_query/read_file/search_files; do not waste turns guessing internal host storage directories.\n\n\
         Task Title: {title}\n\
         Goal / Brief: {goal}\n\
         Success Criteria: {criteria_json}\n{focus}{interactive_hint}\
         Known Worker Evidence Refs: {known_json}\n\
         Worker Output Summary:\n{worker_output}\n\n\
         Evidence citation rules:\n\
         - Every entry in `evidenceRefs` MUST be an exact string copied from `Known Worker Evidence Refs` above OR `tool-result://<toolCallId>` from your own tool calls in this session.\n\
         - NEVER put raw workspace file paths (such as `/path/to/file` or `.git/config`) in `evidenceRefs`.\n\
         - Record non-blocking caveats in `risks` (strings) and any missing evidence in `missingEvidence` (objects `{{\"reason\": \"...\", \"evidenceRefs\": []}}`).\n\n\
         Batch independent read/search tool calls into the same turn and emit your final JSON verdict promptly once verified.\n\
         Respond with ONE valid JSON object (no extra JSON objects) matching:\n\
         {{\"passed\": boolean, \"failedCriteria\": [{{\"criterionId\": \"...\", \"reason\": \"...\", \"evidenceRefs\": [\"...\"]}}], \"missingEvidence\": [{{\"reason\": \"...\", \"evidenceRefs\": [\"...\"]}}], \"risks\": [\"...\"], \"evidenceRefs\": [\"...\"], \"summary\": \"...\"}}"
    )
}

fn build_wrap_up_prompt(verifier_ev_refs: &[String], allowed_refs: &HashSet<String>) -> String {
    let valid_refs = prioritized_allowed_refs(verifier_ev_refs, allowed_refs);
    let valid_json = serde_json::to_string(&valid_refs).unwrap_or_else(|_| "[]".into());
    format!(
        "You have reached the tool-turn limit for verification. Tools are now disabled.\n\
         Respond with ONE valid JSON verdict object matching:\n\
         {{\"passed\": boolean, \"failedCriteria\": [{{\"criterionId\": \"...\", \"reason\": \"...\", \"evidenceRefs\": [\"...\"]}}], \"missingEvidence\": [{{\"reason\": \"...\", \"evidenceRefs\": [\"...\"]}}], \"risks\": [\"...\"], \"evidenceRefs\": [\"...\"], \"summary\": \"...\"}}\n\
         Rules:\n\
         - Every entry in `evidenceRefs` MUST be an exact string from the valid indexed refs below. NEVER put raw file paths in `evidenceRefs`.\n\
         - When `passed` is true, `evidenceRefs` must be non-empty.\n\
         Valid indexed evidenceRefs: {valid_json}"
    )
}

fn build_repair_prompt(
    feedback: &RepairFeedback,
    verifier_ev_refs: &[String],
    allowed_refs: &HashSet<String>,
) -> String {
    let valid_refs = prioritized_allowed_refs(verifier_ev_refs, allowed_refs);
    let valid_json = serde_json::to_string(&valid_refs).unwrap_or_else(|_| "[]".into());
    let (diagnosis, previous_text) = match feedback {
        RepairFeedback::InvalidFormat { previous_text } => (
            "Your previous verifier output could not be decoded as a single valid JSON verdict object. \
             Ensure `passed` is boolean, `failedCriteria` and `missingEvidence` are arrays of `{\"reason\": \"...\", \"evidenceRefs\": []}` objects, \
             `risks` and `evidenceRefs` are arrays of strings, and `evidenceRefs` is non-empty when `passed` is true."
                .to_owned(),
            previous_text.as_str(),
        ),
        RepairFeedback::UnindexedRefs {
            unindexed_refs,
            previous_text,
        } => {
            let bad_json = serde_json::to_string(unindexed_refs).unwrap_or_else(|_| "[]".into());
            (
                format!(
                    "Your previous JSON verdict cited unindexed entries in `evidenceRefs` that are NOT in the host Evidence Index: {bad_json}.\n\
                     Remove those unindexed entries (such as raw workspace file paths) and keep ONLY exact strings from the valid indexed evidenceRefs list below."
                ),
                previous_text.as_str(),
            )
        }
    };
    let clipped: String = previous_text.trim().chars().take(MAX_REPAIR_TEXT).collect();
    format!(
        "Format repair only — tools are disabled. Do not attempt tool calls.\n\
         {diagnosis}\n\n\
         Valid indexed evidenceRefs (cite ONLY exact strings from this list): {valid_json}\n\n\
         Previous output excerpt:\n{clipped}\n\n\
         Return ONE valid JSON object matching:\n\
         {{\"passed\": boolean, \"failedCriteria\": [{{\"criterionId\": \"...\", \"reason\": \"...\", \"evidenceRefs\": [\"...\"]}}], \"missingEvidence\": [{{\"reason\": \"...\", \"evidenceRefs\": [\"...\"]}}], \"risks\": [\"...\"], \"evidenceRefs\": [\"...\"], \"summary\": \"...\"}}"
    )
}

/// Runs the bounded, read-only Independent Verifier episode (up to 2 attempts: initial + 1 tool-less format repair).
pub async fn run_independent_verifier(
    data_home: &Path,
    plan: &Value,
    worker_evidence_refs: &HashSet<String>,
    verifier_model: &NativeModel,
    cancel: &CancellationToken,
) -> Result<VerifierOutcome, ProjectError> {
    run_independent_verifier_with_focus(
        data_home,
        plan,
        worker_evidence_refs,
        None,
        verifier_model,
        cancel,
    )
    .await
}

pub(crate) async fn run_independent_verifier_with_focus(
    data_home: &Path,
    plan: &Value,
    worker_evidence_refs: &HashSet<String>,
    focus: Option<&str>,
    verifier_model: &NativeModel,
    cancel: &CancellationToken,
) -> Result<VerifierOutcome, ProjectError> {
    run_independent_verifier_with_interactive(
        data_home,
        plan,
        worker_evidence_refs,
        focus,
        verifier_model,
        None,
        false,
        cancel,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_independent_verifier_with_interactive(
    data_home: &Path,
    plan: &Value,
    worker_evidence_refs: &HashSet<String>,
    focus: Option<&str>,
    verifier_model: &NativeModel,
    interactive_bridge: Option<Arc<dyn InteractiveContentBridge>>,
    interactive_enabled: bool,
    cancel: &CancellationToken,
) -> Result<VerifierOutcome, ProjectError> {
    let target_ws = plan["targetWorkspacePath"]
        .as_str()
        .or_else(|| plan["originWorkspacePath"].as_str())
        .map(PathBuf::from)
        .ok_or_else(|| ProjectError::code("WORKSPACE_NOT_FOUND"))?;
    let has_interactive_refs = worker_evidence_refs
        .iter()
        .any(|r| r.starts_with(INTERACTIVE_RESULT_PREFIX));
    let mount_interactive =
        interactive_bridge.is_some() && (interactive_enabled || has_interactive_refs);
    let profile =
        resolve_work_session_profile_with_interactive(plan, "verifier", mount_interactive)
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
    // The verifier never prompts, but it reads the same current Bot policy as
    // the session it verifies instead of a level fixed by its role name.
    let workspace_id = plan["delegationOrigin"]["workspaceId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| ProjectError::code("OUT_OF_SCOPE"))?;
    let access = delegated_access(data_home, workspace_id)?;

    let worker_model_id = plan["delegationOrigin"]["modelSelection"]["worker"]["modelId"]
        .as_str()
        .or_else(|| plan["delegationOrigin"]["modelSelection"]["worker"].as_str())
        .unwrap_or("");
    let verifier_model_id = verifier_model.model_id().to_owned();
    let same_family_as_worker = !worker_model_id.is_empty()
        && model_family(worker_model_id) == model_family(&verifier_model_id);

    let evidence_store = EvidenceIndexStore::new(data_home);
    let mut allowed_refs = worker_evidence_refs.clone();
    let mut verifier_ev_refs = Vec::new();
    let mut repair_feedback: Option<RepairFeedback> = None;
    let mut last_conv_id = String::new();

    for attempt in 0..2 {
        if cancel.is_cancelled() {
            return Err(ProjectError::code("CANCELLED"));
        }
        let is_repair = attempt > 0;
        let prompt = match repair_feedback.as_ref() {
            Some(feedback) if is_repair => {
                build_repair_prompt(feedback, &verifier_ev_refs, &allowed_refs)
            }
            _ => build_verifier_prompt(plan, &allowed_refs, focus),
        };
        let runtime = NativeConversationRuntime::new(data_home, access.clone());
        let mut deny_perm = DenyEscalationPermission;
        let reuse_conv_id =
            (is_repair && !last_conv_id.is_empty()).then_some(last_conv_id.as_str());
        let empty_allowlist: [String; 0] = [];
        let allowlist = if is_repair {
            Some(&empty_allowlist[..])
        } else {
            Some(profile.allowlist.as_slice())
        };
        let max_turns = if is_repair { Some(1) } else { Some(12) };
        let mut extra_providers: Vec<Box<dyn CapabilityProvider>> = Vec::new();
        let mut context_extensions: Vec<Value> = Vec::new();
        if !is_repair
            && mount_interactive
            && let Some(ref bridge) = interactive_bridge
            && let (Some(ws_id), Some(parent_cid), Some(plan_id), Some(sess_id), Some(plan_cid)) = (
                plan["delegationOrigin"]["workspaceId"].as_str(),
                plan["delegationOrigin"]["parentConversationId"].as_str(),
                plan["planId"].as_str(),
                plan["delegationOrigin"]["sessionId"].as_str(),
                plan["conversationId"].as_str(),
            )
        {
            let epoch = plan["delegationOrigin"]["executionGeneration"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(plan_id)
                .to_owned();
            extra_providers.push(Box::new(WorkSessionInteractiveProvider::new(
                WorkSessionInteractiveContext {
                    data_home: data_home.to_path_buf(),
                    owner: InteractiveOwner {
                        workspace_id: ws_id.to_owned(),
                        conversation_id: parent_cid.to_owned(),
                    },
                    plan_id: plan_id.to_owned(),
                    session_id: sess_id.to_owned(),
                    plan_conversation_id: plan_cid.to_owned(),
                    execution_epoch: epoch,
                    role: "verifier".to_owned(),
                    can_publish: false,
                    bridge: Arc::clone(bridge),
                    on_published: None,
                },
            )));
            context_extensions.push(interactive_context_extension(Some(bridge.as_ref()), false));
        }
        let mut conv_out = Box::pin(runtime.execute_verification_with_extensions(
            &ConversationOptions {
                workspace: &target_ws,
                conversation_id: reuse_conv_id,
                resume_from: None,
                prompt: &prompt,
                image_paths: &[],
                provider_id: verifier_model.provider(),
                mode: RuntimeMode::Chat,
                effort: "default",
                persist_model_selection: false,
                allowlist,
                max_turns,
            },
            verifier_model,
            &mut deny_perm,
            cancel,
            extra_providers,
            context_extensions,
        ))
        .await?;

        last_conv_id = conv_out.session_id.clone();
        collect_conversation_evidence_refs(
            &evidence_store,
            &last_conv_id,
            &mut allowed_refs,
            &mut verifier_ev_refs,
        );

        if !is_repair && conv_out.error == Some("agent_loop_exhausted") && !cancel.is_cancelled() {
            let wrap_prompt = build_wrap_up_prompt(&verifier_ev_refs, &allowed_refs);
            if let Ok(wrap_out) = Box::pin(runtime.execute_verification(
                &ConversationOptions {
                    workspace: &target_ws,
                    conversation_id: Some(&last_conv_id),
                    resume_from: None,
                    prompt: &wrap_prompt,
                    image_paths: &[],
                    provider_id: verifier_model.provider(),
                    mode: RuntimeMode::Chat,
                    effort: "default",
                    persist_model_selection: false,
                    allowlist: Some(&[]),
                    max_turns: Some(1),
                },
                verifier_model,
                &mut deny_perm,
                cancel,
            ))
            .await
                && wrap_out.error.is_none()
                && !wrap_out.content.trim().is_empty()
            {
                conv_out.content = wrap_out.content;
                conv_out.error = None;
            }
        }

        if conv_out.error == Some("permission_denied") {
            return Ok(VerifierOutcome::InvalidReport {
                error: "verifier_permission_denied",
                summary: "Verifier requested an action outside its read-only permission boundary."
                    .to_owned(),
                verifier_conversation_id: last_conv_id,
            });
        }
        if let Some(err_code) = conv_out.error {
            return Ok(VerifierOutcome::InvalidReport {
                error: err_code,
                summary: err_code.to_owned(),
                verifier_conversation_id: last_conv_id,
            });
        }

        if let Some(report) = decode_verifier_report(&conv_out.content) {
            let unindexed_refs: Vec<String> = if report.passed {
                report
                    .evidence_refs
                    .iter()
                    .filter(|r| !allowed_refs.contains(r.as_str()))
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            if unindexed_refs.is_empty() {
                return Ok(VerifierOutcome::Verified {
                    report,
                    verifier_conversation_id: last_conv_id,
                    verifier_model_id,
                    same_family_as_worker,
                    verifier_evidence_refs: verifier_ev_refs,
                });
            }
            if attempt == 0 {
                repair_feedback = Some(RepairFeedback::UnindexedRefs {
                    unindexed_refs,
                    previous_text: conv_out.content,
                });
            }
        } else if attempt == 0 {
            repair_feedback = Some(RepairFeedback::InvalidFormat {
                previous_text: conv_out.content,
            });
        }
    }

    Ok(VerifierOutcome::InvalidReport {
        error: "verifier_report_invalid",
        summary: "Verifier returned no valid structured report after one retry.".to_owned(),
        verifier_conversation_id: last_conv_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bound_bot(home: &Path, workspace: &Path) -> (crate::NativeProjectHost, String) {
        let host = crate::NativeProjectHost::new(home, "0.1.0-test", Some(1)).unwrap();
        let (entry, _profile) = host.bind_workspace(workspace, Some("Policy Bot")).unwrap();
        (host, entry.workspace_id)
    }

    #[test]
    fn delegated_access_starts_a_bot_without_a_saved_policy_at_ask() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        // This device already saved Full as its old global level.
        PolicyStore::new(home.path())
            .initialize(LocalAccessLevel::FullLocal, &now_iso(), None)
            .unwrap();
        let (_host, workspace_id) = bound_bot(home.path(), workspace.path());
        // A Bot that appears later does not inherit that level: it starts at Ask.
        let access = delegated_access(home.path(), &workspace_id).unwrap();
        assert_eq!(
            access.snapshot().unwrap(),
            (LocalAccessLevel::AskBeforeLocal, 1)
        );
        let saved = PolicyStore::new(home.path())
            .read_existing(&workspace_id)
            .unwrap();
        assert_eq!(saved.access_level, LocalAccessLevel::AskBeforeLocal);
        assert_eq!(saved.source, "new_bot");
    }

    #[test]
    fn delegated_access_creates_a_missing_policy_store_and_follows_saved_changes() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (_host, workspace_id) = bound_bot(home.path(), workspace.path());
        assert!(
            !home
                .path()
                .join("project-runtime/bot-access.sqlite")
                .exists()
        );
        let access = delegated_access(home.path(), &workspace_id).unwrap();
        assert_eq!(
            access.snapshot().unwrap(),
            (LocalAccessLevel::AskBeforeLocal, 1)
        );
        PolicyStore::new(home.path())
            .update_existing(&workspace_id, 1, LocalAccessLevel::FullLocal, &now_iso())
            .unwrap();
        // The session that is already running decides its next call under the
        // level the user just saved.
        assert_eq!(access.snapshot().unwrap(), (LocalAccessLevel::FullLocal, 2));
    }

    #[test]
    fn delegated_access_rejects_a_missing_bot_or_a_damaged_policy_store() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (_host, workspace_id) = bound_bot(home.path(), workspace.path());
        // A plan that names a workspace no Bot owns is not another Bot's session.
        assert_eq!(
            delegated_access(home.path(), "ws-nobody").unwrap_err().code,
            "access_identity_invalid"
        );
        delegated_access(home.path(), &workspace_id).unwrap();
        std::fs::write(
            home.path().join("project-runtime/bot-access.sqlite"),
            "not a policy store",
        )
        .unwrap();
        assert_eq!(
            delegated_access(home.path(), &workspace_id)
                .unwrap_err()
                .code,
            "access_policy_unavailable"
        );
    }

    #[test]
    fn profile_enforces_strict_read_only_and_worker_ceilings() {
        let plan = json!({
            "delegationOrigin": {
                "readOnly": false,
                "requiredCapabilities": [
                    "local.file.write",
                    "local.delegation.spawn_session",
                    "local.web.control.click",
                    "local.file.read"
                ]
            }
        });
        let worker = resolve_work_session_profile(&plan, "worker").expect("worker profile");
        assert!(!worker.read_only);
        assert!(worker.allowlist.contains(&"local.file.write".to_owned()));
        assert!(
            !worker
                .allowlist
                .contains(&"local.delegation.spawn_session".to_owned())
        );
        assert!(
            !worker
                .allowlist
                .contains(&"local.web.control.click".to_owned())
        );

        let verifier = resolve_work_session_profile(&plan, "verifier").expect("verifier profile");
        assert!(verifier.read_only);
        assert!(!verifier.allowlist.contains(&"local.file.write".to_owned()));
        assert!(verifier.allowlist.contains(&"local.file.read".to_owned()));
        assert!(
            verifier
                .allowlist
                .contains(&"local.tool-result.read".to_owned())
        );
    }

    #[test]
    fn decode_verifier_report_handles_fenced_single_and_rejects_ambiguous_or_unbacked() {
        // Requires evidenceRefs when passed == true
        assert!(decode_verifier_report(r#"{"passed":true,"evidenceRefs":[]}"#).is_none());

        // Rejects ambiguous multiple top-level JSON objects
        assert!(
            decode_verifier_report(
                r#"{"passed":false,"summary":"first"} {"passed":true,"evidenceRefs":["ev-1"]}"#
            )
            .is_none()
        );

        // Extracts single JSON object surrounded by prose and braces in quoted summary
        let parsed = decode_verifier_report(
            "Here is my audit:\n```json\n{\"passed\": true, \"evidenceRefs\": [\"ev-1\"], \"summary\": \"checked {a:b} ok\"}\n```",
        )
        .expect("single balanced JSON object");
        assert!(parsed.passed);
        assert_eq!(parsed.evidence_refs, vec!["ev-1"]);
        assert_eq!(parsed.summary, "checked {a:b} ok");
    }

    #[test]
    fn model_family_normalizes_common_prefixes() {
        assert_eq!(model_family("anthropic/claude-sonnet-4"), "claude");
        assert_eq!(model_family("gpt-5.2-codex"), "gpt");
        assert_eq!(model_family("deepseek-v3"), "deepseek");
    }

    #[test]
    fn worker_profile_normalizes_shorthand_capabilities_and_defaults_safely() {
        let shorthand_write = json!({
            "delegationOrigin": {
                "readOnly": false,
                "requiredCapabilities": ["file-write", "shell"]
            }
        });
        let worker =
            resolve_work_session_profile(&shorthand_write, "worker").expect("worker profile");
        for expected in [
            "local.file.read",
            "local.file.list",
            "local.file.search",
            "local.search.aggregate",
            "local.git.query",
            "local.file.write",
            "local.file.edit",
            "local.shell.exec",
            "local.shell.stop",
        ] {
            assert!(
                worker.allowlist.iter().any(|c| c == expected),
                "expected {expected} in worker allowlist {:?}",
                worker.allowlist
            );
        }

        let ro_shorthand = json!({
            "delegationOrigin": {
                "readOnly": true,
                "requiredCapabilities": ["file-write", "shell", "read_file"]
            }
        });
        let ro_worker = resolve_work_session_profile(&ro_shorthand, "worker")
            .expect("read-only worker profile");
        assert!(!ro_worker.allowlist.contains(&"local.file.write".to_owned()));
        assert!(!ro_worker.allowlist.contains(&"local.file.edit".to_owned()));
        assert!(!ro_worker.allowlist.contains(&"local.shell.exec".to_owned()));
        assert!(ro_worker.allowlist.contains(&"local.file.read".to_owned()));

        let verifier =
            resolve_work_session_profile(&shorthand_write, "verifier").expect("verifier profile");
        assert!(!verifier.allowlist.contains(&"local.file.write".to_owned()));
        assert!(!verifier.allowlist.contains(&"local.shell.exec".to_owned()));

        let empty_write = json!({
            "delegationOrigin": {
                "readOnly": false,
                "requiredCapabilities": []
            }
        });
        let fallback_worker =
            resolve_work_session_profile(&empty_write, "worker").expect("fallback worker profile");
        assert!(
            fallback_worker
                .allowlist
                .contains(&"local.file.write".to_owned())
        );
        assert!(
            fallback_worker
                .allowlist
                .contains(&"local.file.edit".to_owned())
        );
        assert!(
            fallback_worker
                .allowlist
                .contains(&"local.shell.exec".to_owned())
        );
        assert!(!fallback_worker.allowlist.iter().any(|c| {
            WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES
                .iter()
                .any(|p| c.starts_with(p))
        }));

        let command_criterion = json!({
            "delegationOrigin": {
                "readOnly": false,
                "requiredCapabilities": ["file-write"]
            },
            "successCriteria": [
                { "kind": "command", "description": "Run tests", "command": "pnpm test" }
            ]
        });
        let cmd_worker = resolve_work_session_profile(&command_criterion, "worker")
            .expect("command criterion worker profile");
        assert!(
            cmd_worker
                .allowlist
                .contains(&"local.shell.exec".to_owned())
        );
        assert!(
            cmd_worker
                .allowlist
                .contains(&"local.shell.stop".to_owned())
        );
    }

    #[test]
    fn verifier_permission_allows_only_read_only_git_config_and_denies_escalations() {
        let mac_gitconfig = json!({
            "capabilityId": "local.git.query",
            "riskLevel": "L1_local_read",
            "scopes": [{
                "kind": "file-read",
                "capabilityId": "local.git.query",
                "path": "/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig"
            }]
        });
        assert!(is_safe_verifier_git_config_read(&mac_gitconfig));

        let user_gitconfig = json!({
            "capabilityId": "local.git.query",
            "riskLevel": "L1_local_read",
            "scopes": [{
                "kind": "file-read",
                "capabilityId": "local.git.query",
                "path": "/Users/alice/.config/git/config"
            }]
        });
        assert!(is_safe_verifier_git_config_read(&user_gitconfig));

        let secret_read = json!({
            "capabilityId": "local.git.query",
            "riskLevel": "L1_local_read",
            "scopes": [{
                "kind": "file-read",
                "capabilityId": "local.git.query",
                "path": "/Users/alice/.ssh/id_rsa"
            }]
        });
        assert!(!is_safe_verifier_git_config_read(&secret_read));

        let plain_file_read = json!({
            "capabilityId": "local.file.read",
            "riskLevel": "L1_local_read",
            "scopes": [{
                "kind": "file-read",
                "capabilityId": "local.file.read",
                "path": "/Users/alice/.gitconfig"
            }]
        });
        assert!(!is_safe_verifier_git_config_read(&plain_file_read));
    }

    #[test]
    fn decode_verifier_report_accepts_string_missing_evidence_and_prompts_guide_refs() {
        let parsed = decode_verifier_report(
            r#"{"passed":true,"failedCriteria":[],"missingEvidence":["PR body not independently fetched"],"risks":["PR base is main"],"evidenceRefs":["tool-result://call-1"],"summary":"All criteria verified."}"#,
        )
        .expect("string missingEvidence should lift to VerifierIssue");
        assert!(parsed.passed);
        assert_eq!(parsed.missing_evidence.len(), 1);
        assert_eq!(
            parsed.missing_evidence[0].reason,
            "PR body not independently fetched"
        );
        assert!(parsed.missing_evidence[0].evidence_refs.is_empty());

        // Blank string items remain invalid.
        assert!(
            decode_verifier_report(
                r#"{"passed":true,"missingEvidence":["   "],"evidenceRefs":["tool-result://call-1"]}"#
            )
            .is_none()
        );

        let allowed: HashSet<String> = ["tool-result://call-1".to_owned()].into_iter().collect();
        let initial = build_verifier_prompt(&json!({"title": "T", "goal": "G"}), &allowed, None);
        assert!(initial.contains("NEVER put raw workspace file paths"));
        assert!(initial.contains(r#""missingEvidence": [{"reason": "...""#));

        let repair = build_repair_prompt(
            &RepairFeedback::UnindexedRefs {
                unindexed_refs: vec!["/repo/.git/config".to_owned()],
                previous_text: r#"{"passed":true}"#.to_owned(),
            },
            &["tool-result://call-v1".to_owned()],
            &allowed,
        );
        assert!(repair.contains("Format repair only"));
        assert!(repair.contains("/repo/.git/config"));
        assert!(repair.contains("tool-result://call-v1"));
        assert!(repair.contains("tool-result://call-1"));
    }

    #[test]
    fn bot_mounted_capabilities_inherited_by_worker_and_isolated_from_verifier() {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("home");
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(home.join("skills/alpha-skill")).unwrap();
        std::fs::create_dir_all(home.join("skills/beta-skill")).unwrap();
        std::fs::create_dir_all(ws.join("skills/local-skill")).unwrap();

        std::fs::write(
            home.join("skills/alpha-skill/SKILL.md"),
            "---\nname: Alpha Skill\ndescription: Global enabled skill\n---\nBody alpha\n",
        )
        .unwrap();
        std::fs::write(
            home.join("skills/beta-skill/SKILL.md"),
            "---\nname: Beta Skill\ndescription: Global disabled skill\n---\nBody beta\n",
        )
        .unwrap();
        std::fs::write(
            ws.join("skills/local-skill/SKILL.md"),
            "---\nname: Local Skill\ndescription: Workspace skill\n---\nBody local\n",
        )
        .unwrap();
        std::fs::write(
            home.join("skills/settings.json"),
            r#"{"disabled":["beta-skill"],"workspaceDisabled":{},"workspaceEnabled":{}}"#,
        )
        .unwrap();
        std::fs::write(
            home.join("mcp-registry.json"),
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "servers": [
                    {
                        "id": "docs-mcp",
                        "displayName": "Docs Server",
                        "enabled": true,
                        "transport": "streamable_http",
                        "url": "https://example.com/mcp",
                        "auth": { "mode": "none" },
                        "policy": { "trusted": true, "visibleByDefault": true, "requirePermission": true },
                        "tools": [
                            { "name": "search_docs", "description": "Search docs", "riskLevel": "L1_local_read" },
                            { "name": "publish_doc", "description": "Publish doc", "riskLevel": "L3_external_write" }
                        ]
                    },
                    {
                        "id": "ops-mcp",
                        "displayName": "Ops Server",
                        "enabled": false,
                        "transport": "streamable_http",
                        "url": "https://ops.example.com/mcp",
                        "auth": { "mode": "none" },
                        "policy": { "trusted": true, "visibleByDefault": true, "requirePermission": true },
                        "tools": [
                            { "name": "deploy_app", "description": "Deploy", "riskLevel": "L3_external_write" }
                        ]
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let rw_plan = json!({
            "delegationOrigin": {
                "readOnly": false,
                "requiredCapabilities": ["local.file.read", "local.file.edit"]
            }
        });
        let ro_plan = json!({
            "delegationOrigin": {
                "readOnly": true,
                "requiredCapabilities": ["local.file.read"]
            }
        });

        // 1. Default inherit: alpha-skill + local-skill + docs-mcp tools; beta-skill & ops-mcp excluded.
        let mut rw_default = resolve_work_session_profile(&rw_plan, "worker").unwrap();
        extend_worker_allowlist_with_bot_capabilities(&home, &ws, None, &mut rw_default);
        assert!(
            rw_default
                .allowlist
                .contains(&"local.skill.alpha-skill".to_owned())
        );
        assert!(
            rw_default
                .allowlist
                .contains(&"local.skill.local-skill".to_owned())
        );
        assert!(
            !rw_default
                .allowlist
                .contains(&"local.skill.beta-skill".to_owned())
        );
        assert!(
            rw_default
                .allowlist
                .contains(&"local.mcp.docs-mcp.search_docs".to_owned())
        );
        assert!(
            rw_default
                .allowlist
                .contains(&"local.mcp.docs-mcp.publish_doc".to_owned())
        );
        assert!(
            !rw_default
                .allowlist
                .contains(&"local.mcp.ops-mcp.deploy_app".to_owned())
        );

        // 2. Per-Bot overrides: disable alpha-skill & docs-mcp, enable beta-skill & ops-mcp.
        let policy = BotCapabilityPolicy {
            enabled_skill_ids: vec!["beta-skill".into()],
            disabled_skill_ids: vec!["alpha-skill".into()],
            enabled_mcp_ids: vec!["ops-mcp".into()],
            disabled_mcp_ids: vec!["docs-mcp".into()],
        };
        let mut rw_override = resolve_work_session_profile(&rw_plan, "worker").unwrap();
        extend_worker_allowlist_with_bot_capabilities(&home, &ws, Some(&policy), &mut rw_override);
        assert!(
            !rw_override
                .allowlist
                .contains(&"local.skill.alpha-skill".to_owned())
        );
        assert!(
            rw_override
                .allowlist
                .contains(&"local.skill.beta-skill".to_owned())
        );
        assert!(
            rw_override
                .allowlist
                .contains(&"local.skill.local-skill".to_owned())
        );
        assert!(
            !rw_override
                .allowlist
                .contains(&"local.mcp.docs-mcp.search_docs".to_owned())
        );
        assert!(
            rw_override
                .allowlist
                .contains(&"local.mcp.ops-mcp.deploy_app".to_owned())
        );

        // 3. Read-only worker inherits mounted skills + read-only MCP only (no L3_external_write MCP).
        let mut ro_worker = resolve_work_session_profile(&ro_plan, "worker").unwrap();
        extend_worker_allowlist_with_bot_capabilities(&home, &ws, None, &mut ro_worker);
        assert!(
            ro_worker
                .allowlist
                .contains(&"local.skill.alpha-skill".to_owned())
        );
        assert!(
            ro_worker
                .allowlist
                .contains(&"local.mcp.docs-mcp.search_docs".to_owned())
        );
        assert!(
            !ro_worker
                .allowlist
                .contains(&"local.mcp.docs-mcp.publish_doc".to_owned())
        );

        // 4. Independent verifier NEVER gets skills or MCP.
        let mut verifier_profile = resolve_work_session_profile(&rw_plan, "verifier").unwrap();
        extend_worker_allowlist_with_bot_capabilities(
            &home,
            &ws,
            Some(&policy),
            &mut verifier_profile,
        );
        assert!(
            !verifier_profile
                .allowlist
                .iter()
                .any(|c| c.starts_with("local.skill."))
        );
        assert!(
            !verifier_profile
                .allowlist
                .iter()
                .any(|c| c.starts_with("local.mcp."))
        );

        // 5. Summary reflects Bot overrides for L4_CAPABILITIES.
        let summary = render_bot_mounted_capabilities_summary(&home, &ws, Some(&policy))
            .expect("summary expected");
        assert!(summary.contains("beta-skill"));
        assert!(!summary.contains("alpha-skill"));
        assert!(summary.contains("Ops Server"));
        assert!(!summary.contains("Docs Server"));
    }

    #[test]
    fn read_only_web_research_grants_web_search_and_fetch_to_worker_only() {
        let web_research_plan = json!({
            "delegationOrigin": {
                "readOnly": true,
                "requiredCapabilities": [
                    "local.file.read",
                    "local.file.list",
                    "local.file.search",
                    "local.git.query",
                    "local.web.search",
                    "local.web.fetch"
                ]
            }
        });
        let worker =
            resolve_work_session_profile(&web_research_plan, "worker").expect("worker profile");
        assert!(worker.read_only);
        assert!(worker.allowlist.contains(&"local.web.search".to_owned()));
        assert!(worker.allowlist.contains(&"local.web.fetch".to_owned()));
        assert!(worker.allowlist.contains(&"local.file.read".to_owned()));
        for forbidden in [
            "local.file.write",
            "local.file.edit",
            "local.shell.exec",
            "local.shell.stop",
        ] {
            assert!(
                !worker.allowlist.iter().any(|c| c == forbidden),
                "read-only web research worker must not receive {forbidden}"
            );
        }

        // Shorthand `web_research` only still keeps local read-only tools + web_search + web_fetch.
        let shorthand_plan = json!({
            "delegationOrigin": {
                "readOnly": true,
                "requiredCapabilities": ["web_research"]
            }
        });
        let shorthand_worker = resolve_work_session_profile(&shorthand_plan, "worker")
            .expect("shorthand worker profile");
        assert!(
            shorthand_worker
                .allowlist
                .contains(&"local.web.search".to_owned())
        );
        assert!(
            shorthand_worker
                .allowlist
                .contains(&"local.web.fetch".to_owned())
        );
        assert!(
            shorthand_worker
                .allowlist
                .contains(&"local.file.read".to_owned())
        );

        // Independent verifier and explorer NEVER receive `local.web.search` or `local.web.fetch`.
        for role in ["verifier", "explorer"] {
            let role_profile =
                resolve_work_session_profile(&web_research_plan, role).expect("role profile");
            assert!(role_profile.read_only);
            assert!(
                !role_profile
                    .allowlist
                    .contains(&"local.web.search".to_owned()),
                "{role} must never receive local.web.search"
            );
            assert!(
                !role_profile
                    .allowlist
                    .contains(&"local.web.fetch".to_owned()),
                "{role} must never receive local.web.fetch"
            );
        }

        // Default read-only worker (no web tools requested) stays strictly local.
        let plain_ro_plan = json!({
            "delegationOrigin": {
                "readOnly": true,
                "requiredCapabilities": []
            }
        });
        let plain_ro_worker =
            resolve_work_session_profile(&plain_ro_plan, "worker").expect("plain read-only worker");
        assert!(
            !plain_ro_worker
                .allowlist
                .contains(&"local.web.search".to_owned())
        );
        assert!(
            !plain_ro_worker
                .allowlist
                .contains(&"local.web.fetch".to_owned())
        );
    }
}
