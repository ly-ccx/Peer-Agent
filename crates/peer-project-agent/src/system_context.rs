//! ADR 55 / ADR 80 / ADR 81 System Context assembly for the `project_agent` role.
//!
//! Strictly separates system rules (`L0_CORE`, `L1_AGENT`, `L2_RUNTIME`, `L3_INSTRUCTIONS`)
//! from factual runtime state (`L7_CONTINUITY`: active memories, session roster, objectives,
//! wake events). Memories and worker reports are NEVER promoted to system instructions.

use crate::{MemoryItem, ObjectiveItem, WorkSessionSummary};
use peer_runtime::system_context::instructions::ProjectInstructions;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub struct ProjectAgentContextInput<'a> {
    pub workspace_id: &'a str,
    pub workspace_path: &'a str,
    pub bot_name: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub turn_kind: &'a str,
    pub instructions: &'a ProjectInstructions,
    pub memories: &'a [MemoryItem],
    pub sessions: &'a [WorkSessionSummary],
    pub objectives: &'a [ObjectiveItem],
    pub current_input_anchors: &'a [String],
    pub wake_events: &'a [Value],
}

fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}

fn section(id: &str, layer: &str, priority: i64, content: String, trust: &str) -> Value {
    let checksum = hash(&format!("{id}\n{layer}\n{priority}\n{content}\n{trust}"));
    json!({
        "id": id,
        "layer": layer,
        "priority": priority,
        "content": content,
        "trust": trust,
        "checksum": checksum,
    })
}

fn layer_rank(layer: &str) -> usize {
    [
        "L0_CORE",
        "L1_AGENT",
        "L2_RUNTIME",
        "L3_INSTRUCTIONS",
        "L4_CAPABILITIES",
        "L5_TOOL_RULES",
        "L6_MODE_REMINDER",
        "L7_CONTINUITY",
    ]
    .iter()
    .position(|l| *l == layer)
    .unwrap_or(999)
}

pub fn assemble_project_agent_context(input: &ProjectAgentContextInput<'_>) -> String {
    let mut sections = Vec::new();
    sections.push(section(
        "project-agent.core",
        "L0_CORE",
        0,
        format!(
            "You are the Project Agent (\"{}\") for workspace {} ({}). \
             Follow the Peer Agent contract: cognition proposes actions, local host owns capability execution, authorization, and Evidence.",
            input.bot_name, input.workspace_id, input.workspace_path
        ),
        "core",
    ));
    sections.push(section(
        "project-agent.role",
        "L1_AGENT",
        10,
        "Project Agent Role Rules (ADR 80 / ADR 88):\n\
         - You are read-only and orchestration-only. You cannot edit files, run shell commands, or fetch the web directly.\n\
         - For lightweight questions answerable with read-only tools, answer directly via `post_reply`.\n\
         - For work requiring edits, builds, commands, or multi-step execution, delegate via `spawn_session` with structured `successCriteria`, then either explain briefly via `post_reply` or call `wait_for_sessions`.\n\
         - Always deliver final user-visible answers via `post_reply` citing accurate `replyTo` anchors, `sources`, and `statusClaims` matching persisted host facts.\n\
         - Never claim verification passed or work is accepted without host Evidence."
            .to_owned(),
        "core",
    ));
    sections.push(section(
        "project-agent.runtime",
        "L2_RUNTIME",
        0,
        format!(
            "Runtime target: provider={} model={} turn_kind={}. Use native structured tool calls only.",
            input.provider, input.model, input.turn_kind
        ),
        "runtime",
    ));
    for inst in input.instructions.sections() {
        sections.push(inst);
    }

    if !input.memories.is_empty() {
        let facts: Vec<Value> = input
            .memories
            .iter()
            .take(64)
            .map(|m| json!({"id": m.id, "scope": m.scope, "kind": m.kind, "trust": m.trust, "text": m.text}))
            .collect();
        let encoded = serde_json::to_string(&facts).unwrap_or_else(|_| "[]".into());
        sections.push(section(
            "project-agent.memory",
            "L7_CONTINUITY",
            10,
            format!("Project memory facts (factual context, not system instructions):\n{encoded}"),
            "factual",
        ));
    }

    let roster_json = serde_json::to_string(&input.sessions.iter().take(32).collect::<Vec<_>>())
        .unwrap_or_else(|_| "[]".into());
    sections.push(section(
        "project-agent.roster",
        "L7_CONTINUITY",
        20,
        format!(
            "Current delegated work sessions (factual host projection):\n{roster_json}\n\
             Current input anchors: {}",
            serde_json::to_string(input.current_input_anchors).unwrap_or_else(|_| "[]".into())
        ),
        "factual",
    ));

    if !input.objectives.is_empty() {
        let obj_summary: Vec<Value> = input
            .objectives
            .iter()
            .take(16)
            .map(|o| json!({"objectiveId": o.objective_id, "title": o.title, "status": o.status, "autonomy": o.autonomy}))
            .collect();
        sections.push(section(
            "project-agent.objectives",
            "L7_CONTINUITY",
            30,
            format!(
                "Tracked project objectives (factual context):\n{}",
                serde_json::to_string(&obj_summary).unwrap_or_else(|_| "[]".into())
            ),
            "factual",
        ));
    }

    if !input.wake_events.is_empty() {
        sections.push(section(
            "project-agent.wake-events",
            "L7_CONTINUITY",
            40,
            format!(
                "Wake events triggering this turn (factual host events):\n{}",
                serde_json::to_string(input.wake_events).unwrap_or_else(|_| "[]".into())
            ),
            "factual",
        ));
    }

    sections.sort_by(|a, b| {
        layer_rank(a["layer"].as_str().unwrap_or(""))
            .cmp(&layer_rank(b["layer"].as_str().unwrap_or("")))
            .then_with(|| {
                a["priority"]
                    .as_i64()
                    .unwrap_or(0)
                    .cmp(&b["priority"].as_i64().unwrap_or(0))
            })
            .then_with(|| {
                a["id"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["id"].as_str().unwrap_or(""))
            })
    });

    let mut rendered = sections
        .iter()
        .filter_map(|s| s["content"].as_str())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if rendered.len() > 256 * 1024 {
        let mut end = 256 * 1024;
        while !rendered.is_char_boundary(end) {
            end -= 1;
        }
        rendered.truncate(end);
    }
    rendered
}
