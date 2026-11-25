//! Progressive 3-tier capability projection and built-in Skill Packs for `project_agent`.
//!
//! All governed handlers remain registered in `ProjectCapabilityProvider`; this module
//! controls only which subset is projected into a turn's `RuntimeProjection` so normal
//! turns stay compact (~14 tools instead of 43) while preserving full backward compatibility
//! and strict `RuntimeMode::ProjectAgent` read-only/orchestration security ceilings.

use peer_runtime::providers::RuntimeProjection;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub const ACTIVATE_SKILL_PACK_TOOL: &str = "activate_skill_pack";
pub const ACTIVATE_SKILL_PACK_CAPABILITY: &str = "local.delegation.activate_skill_pack";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolProjectionMode {
    Progressive,
    Full,
}

impl ToolProjectionMode {
    pub fn from_env() -> Self {
        match std::env::var("PEER_PROJECT_AGENT_TOOL_PROJECTION")
            .ok()
            .as_deref()
            .map(str::trim)
        {
            Some(v) if v.eq_ignore_ascii_case("full") => Self::Full,
            _ => Self::Progressive,
        }
    }
}

/// Tier 1: core always-projected capabilities for every `project_agent` turn.
/// Order is frozen at the prefix of `tools_json` to preserve provider prompt-cache stability.
pub const CORE_CAPABILITIES: [&str; 14] = [
    "local.file.read",
    "local.file.list",
    "local.file.search",
    "local.search.aggregate",
    "local.git.query",
    "local.tool-result.read",
    "local.delegation.spawn_session",
    "local.delegation.list_sessions",
    "local.delegation.get_session",
    "local.delegation.wait_for_sessions",
    "local.delegation.post_reply",
    "local.delegation.search_history",
    "local.memory.search",
    ACTIVATE_SKILL_PACK_CAPABILITY,
];

#[derive(Debug, Clone, Copy)]
pub struct SkillPackSpec {
    pub id: &'static str,
    pub summary: &'static str,
    pub capabilities: &'static [&'static str],
    pub guide: &'static str,
}

pub const SKILL_PACKS: [SkillPackSpec; 7] = [
    SkillPackSpec {
        id: "session_ops",
        summary: "inspect verification details, verify, cancel, resume, or message delegated work sessions",
        capabilities: &[
            "local.delegation.get_verification_detail",
            "local.delegation.verify_session",
            "local.delegation.cancel_session",
            "local.delegation.resume_session",
            "local.delegation.message_session",
        ],
        guide: "# Session Operations Guide\n\
                - Use `get_verification_detail` to inspect verdict checks, evidence refs, and changed files before claiming verification passed.\n\
                - Use `verify_session` on completed, unaccepted work after verifier failure. It runs a bounded independent read-only check. Supply focus only for a relevant review question.\n\
                - Use `cancel_session` to cancel/dismiss active, queued, unaccepted `result_ready`, `failed`, `verification_failed`, or stale `cancelled` sessions; you may cancel dead `failed` / `verification_failed` / stale-cancelled sessions autonomously even during wake turns.\n\
                - On wake, use `message_session(intent=answer)` for a pending technical question addressed to this Bot and `resume_session` for a host-confirmed recoverable interruption. Human decisions, amendments, and user pauses need a current user input.",
    },
    SkillPackSpec {
        id: "memory",
        summary: "save durable project facts/decisions/user preferences, list active memories, or forget stale memories",
        capabilities: &[
            "local.memory.remember",
            "local.memory.list",
            "local.memory.forget",
        ],
        guide: "# Project & User Memory Guide\n\
                - Use `memory_remember` to record concise factual project decisions, procedures, responsibilities, or user preferences.\n\
                - Never include secrets, tokens, or speculative claims; host automatically assigns scope and trust metadata.\n\
                - Use `memory_list` to inspect active items and `memory_forget` to retire outdated memories.",
    },
    SkillPackSpec {
        id: "objectives",
        summary: "create, inspect, update, pause, resume, close, or propose actions on tracked long-running objectives",
        capabilities: &[
            "local.objective.create",
            "local.objective.list",
            "local.objective.get",
            "local.objective.update",
            "local.objective.pause",
            "local.objective.resume",
            "local.objective.close",
            "local.objective.propose_action",
        ],
        guide: "# Tracked Objectives Guide\n\
                - Use `create_objective` to track ongoing goals with milestones, watches, budgets, or deadlines.\n\
                - Pass `expectedVersion` when calling `update_objective`, `pause_objective`, or `resume_objective`.\n\
                - Use `propose_objective_action` for active watch event batches; auto-spawning only occurs when autonomy permits it.",
    },
    SkillPackSpec {
        id: "coordination",
        summary: "advanced multi-agent mailbox messaging, revision-guarded work control, reprioritization, and proactivity level",
        capabilities: &[
            "local.delegation.send_agent_message",
            "local.delegation.coordinate_work",
            "local.delegation.control_work",
            "local.delegation.reprioritize_session",
            "local.delegation.set_proactivity",
        ],
        guide: "# Multi-Agent Coordination Guide\n\
                - Use `send_agent_message` to deliver durable updates, questions, or answers to an active child session mailbox.\n\
                - Use `coordinate_work` (`query`, `parallel`, `revise`, `replace`, `handoff`, etc.) with `expectedRevision` for revision-guarded changes.\n\
                - Use `control_work`, `reprioritize_session`, or `set_proactivity` when directed by a current user message.",
    },
    SkillPackSpec {
        id: "continuity",
        summary: "read or write versioned working notes, search work history pages, or prepare context handoff windows",
        capabilities: &[
            "local.continuity.read_notes",
            "local.continuity.write_note",
            "local.continuity.search_history",
            "local.continuity.prepare_handoff",
        ],
        guide: "# Working Context Continuity Guide\n\
                - Use `read_work_notes` and `write_work_note` (with optimistic `expectedRevision`) for scoped cross-turn handoff notes.\n\
                - Use `search_work_history` to search paginated work transcripts with automatic secret redaction.\n\
                - Use `prepare_context_handoff` before handing off long-running multi-step coordination.",
    },
    SkillPackSpec {
        id: "obligations",
        summary: "inspect unsettled execution obligations, request user authorization grants, and resolve confirmed obligations",
        capabilities: &[
            "local.delegation.inspect_execution_obligation",
            "local.delegation.request_obligation_authorization",
            "local.delegation.resolve_execution_obligation",
        ],
        guide: "# Execution Obligations Guide\n\
                - Inspect unsettled claims or unknown outcomes first with `inspect_execution_obligation`.\n\
                - Never bypass user confirmation: call `request_obligation_authorization` with exact `obligationId`, `operationId`, and `evidenceRevision`.\n\
                - After user approval, call `resolve_execution_obligation` with the granted `grantId` and an idempotent `idempotencyKey`.",
    },
    SkillPackSpec {
        id: "interactive",
        summary: "publish interactive OpenUI reply cards directly (Desktop) or inspect admitted interactive results",
        capabilities: &[
            peer_protocol::interactive_result::INTERACTIVE_PUBLISH_CAPABILITY,
            crate::INTERACTIVE_INSPECT_CAPABILITY,
        ],
        guide: "# Interactive Results Guide\n\
                - On Desktop with Interactive Results enabled, call `publish_interactive_result` directly to attach an interactive OpenUI card (filterable table, chart, comparison, or calculator) that renders inline inside your reply bubble, then summarize via `post_reply`.\n\
                - Use `inspect_interactive_result` with `view: \"metadata\"` or `\"text\"` to inspect admitted interactive results belonging to this project.\n\
                - Interactive controls stay local and never grant file write, shell, or approval authority.",
    },
];

pub fn find_skill_pack(id: &str) -> Option<&'static SkillPackSpec> {
    let trimmed = id.trim();
    SKILL_PACKS.iter().find(|p| p.id == trimmed)
}

pub fn all_skill_pack_ids() -> Vec<&'static str> {
    SKILL_PACKS.iter().map(|p| p.id).collect()
}

/// Host state signals used to auto-project Tier-2 packs with zero extra model rounds.
#[derive(Debug, Clone, Default)]
pub struct TurnProjectionSignals {
    pub has_sessions: bool,
    pub has_objectives: bool,
    pub has_obligations: bool,
    pub has_interactive_results: bool,
    pub has_working_context: bool,
}

pub fn auto_activated_packs(signals: &TurnProjectionSignals) -> Vec<String> {
    let mut packs = Vec::new();
    if signals.has_sessions {
        packs.push("session_ops".to_owned());
    }
    if signals.has_objectives {
        packs.push("objectives".to_owned());
    }
    if signals.has_obligations {
        packs.push("obligations".to_owned());
    }
    if signals.has_interactive_results {
        packs.push("interactive".to_owned());
    }
    if signals.has_working_context {
        packs.push("continuity".to_owned());
    }
    packs
}

/// Build an ordered capability allowlist: Tier 1 core first, then initial Tier 2 packs,
/// then dynamically activated Tier 3 packs strictly appended at the tail.
pub fn build_allowlist(initial_packs: &[String], activated_packs: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push_unique = |cap: &str| {
        if seen.insert(cap.to_owned()) {
            out.push(cap.to_owned());
        }
    };
    for cap in CORE_CAPABILITIES {
        push_unique(cap);
    }
    for pack_id in initial_packs.iter().chain(activated_packs.iter()) {
        if let Some(pack) = find_skill_pack(pack_id) {
            for cap in pack.capabilities {
                push_unique(cap);
            }
        }
    }
    out
}

/// Return tool definitions sorted by `ordered_caps` so newly activated packs always append
/// to the end of `tools_json`, preserving provider KV prompt-cache prefixes across rounds.
pub fn ordered_definitions(projection: &RuntimeProjection, ordered_caps: &[String]) -> Value {
    let defs = projection.definitions();
    let Some(items) = defs.as_array() else {
        return defs;
    };
    let rank: HashMap<&str, usize> = ordered_caps
        .iter()
        .enumerate()
        .map(|(idx, cap)| (cap.as_str(), idx))
        .collect();
    let mut indexed: Vec<(usize, usize, Value)> = items
        .iter()
        .enumerate()
        .map(|(orig_idx, item)| {
            let name = item["function"]["name"].as_str().unwrap_or("");
            let pos = projection
                .capability(name)
                .and_then(|cap| rank.get(cap).copied())
                .unwrap_or(usize::MAX);
            (pos, orig_idx, item.clone())
        })
        .collect();
    indexed.sort_by_key(|(pos, orig_idx, _)| (*pos, *orig_idx));
    json!(
        indexed
            .into_iter()
            .map(|(_, _, item)| item)
            .collect::<Vec<_>>()
    )
}

/// Render a compact directory of unactivated packs (~100 tokens) for the system prompt.
pub fn render_unactivated_pack_catalog(active_packs: &[String]) -> Option<String> {
    let active: HashSet<&str> = active_packs.iter().map(String::as_str).collect();
    let lines: Vec<String> = SKILL_PACKS
        .iter()
        .filter(|pack| !active.contains(pack.id))
        .map(|pack| format!("- {}: {}", pack.id, pack.summary))
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "On-Demand Capability Packs (call `{ACTIVATE_SKILL_PACK_TOOL}` with pack IDs when needed to unlock tools and guides):\n{}",
        lines.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_packs_never_include_write_shell_web_or_legacy_memory_write() {
        let forbidden = [
            "local.file.write",
            "local.file.edit",
            "local.shell.exec",
            "local.shell.stop",
            "local.web.fetch",
            "local.web.search",
            "local.memory.write",
        ];
        for cap in CORE_CAPABILITIES {
            assert!(
                !forbidden.contains(&cap),
                "core capability must not include forbidden cap {cap}"
            );
        }
        for pack in SKILL_PACKS {
            for cap in pack.capabilities {
                assert!(
                    !forbidden.contains(cap),
                    "pack {} must not include forbidden cap {cap}",
                    pack.id
                );
            }
        }
    }

    #[test]
    fn build_allowlist_preserves_stable_prefix_and_appends_dynamic_packs() {
        let initial = auto_activated_packs(&TurnProjectionSignals {
            has_sessions: true,
            ..Default::default()
        });
        let base = build_allowlist(&initial, &[]);
        assert_eq!(base.len(), CORE_CAPABILITIES.len() + 5);

        let expanded = build_allowlist(&initial, &["objectives".to_owned(), "memory".to_owned()]);
        assert_eq!(
            &expanded[..base.len()],
            &base[..],
            "initial prefix must remain byte-identical when new packs activate"
        );
        assert!(expanded.iter().any(|c| c == "local.objective.create"));
        assert!(expanded.iter().any(|c| c == "local.memory.remember"));
        assert!(!expanded.iter().any(|c| c == "local.memory.write"));
    }

    #[test]
    fn catalog_omits_already_active_packs() {
        let cat = render_unactivated_pack_catalog(&["session_ops".into(), "objectives".into()])
            .expect("remaining packs listed");
        assert!(!cat.contains("- session_ops:"));
        assert!(!cat.contains("- objectives:"));
        assert!(cat.contains("- memory:"));
        assert!(cat.contains("- continuity:"));

        let all: Vec<String> = SKILL_PACKS.iter().map(|p| p.id.to_owned()).collect();
        assert!(render_unactivated_pack_catalog(&all).is_none());
    }
}
