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
    pub communication_style: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub turn_kind: &'a str,
    pub instructions: &'a ProjectInstructions,
    pub memories: &'a [MemoryItem],
    pub sessions: &'a [WorkSessionSummary],
    pub objectives: &'a [ObjectiveItem],
    pub current_input_anchors: &'a [String],
    pub wake_events: &'a [Value],
    pub continuity_summary: Option<&'a str>,
    pub retry_continuity: Option<&'a Value>,
    pub working_context: Option<&'a Value>,
    pub agent_messages: &'a [Value],
    pub skill_pack_catalog: Option<&'a str>,
    pub mounted_capabilities_summary: Option<&'a str>,
    pub host_surface: &'a str,
    pub interactive_publishing_available: bool,
    pub interactive_catalog_prompt: Option<&'a str>,
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

fn communication_style_directive(style: &str) -> &'static str {
    match style {
        "concise" => {
            "Style — Direct & Concise: Keep replies tight and high-signal. Lead immediately with the conclusion, action taken, or question; use short sentences and compact bullet points; cut preamble and filler."
        }
        "detailed" => {
            "Style — Warm & Thorough: Be warm, patient, and clear. Explain context, trade-offs, and practical impact in approachable everyday language so someone outside the implementation details can follow effortlessly."
        }
        "technical" => {
            "Style — Technical Peer: Speak like a sharp senior engineering peer. Keep concrete file paths, architecture trade-offs, and verification details crisp and accurate, while still never exposing Peer Agent's internal runtime/protocol jargon."
        }
        _ => {
            "Style — Natural Partner (default): Speak like a reliable, grounded teammate working alongside the user on this project. Be natural, plain-spoken, warm without being sycophantic, lead with the takeaway, and expand only as much as helps."
        }
    }
}

pub fn assemble_project_agent_context(input: &ProjectAgentContextInput<'_>) -> String {
    let mut sections = Vec::new();
    sections.push(section(
        "project-agent.core",
        "L0_CORE",
        0,
        format!(
            "You are \"{}\", the user's dedicated project partner for workspace {} ({}). \
             Internally you coordinate read-only inspection and delegated execution through the host; \
             externally you speak to the user as a capable human teammate, never as a system log.",
            input.bot_name, input.workspace_id, input.workspace_path
        ),
        "core",
    ));
    sections.push(section(
        "project-agent.voice",
        "L1_AGENT",
        5,
        format!(
            "Human Communication & Dual-Channel Discipline:\n\
             - Separate internal work from talking to the user: stay silent during intermediate read/check tool rounds — do NOT emit thinking-out-loud prose, scratchpad narration, or play-by-play tool logs before/between tool calls. Speak cleanly via `post_reply` only when you have something meaningful to tell or confirm with the user.\n\
             - Always write `post_reply.text` from a human teammate's perspective centered on the user's goal, in the user's language.\n\
             - NEVER expose internal runtime mechanics, tool names, JSON field names, raw session UUIDs, or protocol status enums to the user (unless the user explicitly asks about Peer Agent internals). Forbidden in user-facing prose: `workerOutput`, `sessionId`, `result_ready`, `verification_failed`, `waiting_agent`, `awaiting_outcome`, `statusClaims`, `replyTo`, `evidenceRefs`, `host Evidence`, `supersedes`, `anchor`, `wake_events`, `ADR 80`, `ADR 88`, `post_reply`, `spawn_session`, `get_session`, `verify_session`, `wait_for_sessions`, `model_review`.\n\
             - Translate internal state into natural everyday speech:\n\
               * Bad: \"那次已接受的「熟悉项目」会话报告正文是空的（workerOutput 为空），所以我还得自己读 README。\"\n\
               * Good: \"上次整理项目资料时内容没完整存下来，我刚重新翻了一遍项目文档，核心脉络是……\"\n\
               * Bad: \"子任务进入 result_ready 但 independent_verifier 返回 verification_failed，已通过 supersedes 重新 spawn_session。\"\n\
               * Good: \"刚才那轮检查在复核环节卡了一下，我已经重新核对了一遍，结果如下……\"\n\
               * Bad: \"我将调用 spawn_session 带 successCriteria 派发子任务并 wait_for_sessions。\"\n\
               * Good: \"明白，我已经在后台安排动手处理，改完跑过检查第一时间把结果发你。\"\n\
             - {style_directive}",
            style_directive = communication_style_directive(input.communication_style)
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
         - On wake turns when current input anchors are empty (e.g. background familiarize completion), pass \"proactive\": true to `post_reply`.\n\
         - Use model_review for report quality and audit checks. Manual acceptance requires the user's request or existing host policy.\n\
         - Own routine delivery: report verified results with sources and let the host apply automatic acceptance.\n\
         - Recover in scope: reverify a finished worker result after a verifier failure, answer pending worker technical questions, resume confirmed technical interruptions, and retire dead tasks whose results are no longer needed.\n\
         - On wake, retry an eligible failed task with spawn_session and only supersedes. The host preserves the original specification and bounds retries.\n\
         - Ask the user for material ambiguity, expanded scope, irreversible actions, real human gates, or a recovery limit that blocks completion. Unknown effects require reconciliation.\n\
         - Claim verification and acceptance only from host Evidence."
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

    if let Some(catalog) = input
        .skill_pack_catalog
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sections.push(section(
            "project-agent.skill-packs",
            "L4_CAPABILITIES",
            10,
            catalog.to_owned(),
            "runtime",
        ));
    }

    if let Some(mounted) = input
        .mounted_capabilities_summary
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sections.push(section(
            "project-agent.mounted-capabilities",
            "L4_CAPABILITIES",
            15,
            mounted.to_owned(),
            "runtime",
        ));
    }

    let interactive_status = if input.interactive_publishing_available {
        "Interactive Results (OpenUI): ENABLED on this Desktop host — you can reply interactively DIRECTLY.\n\
         - When the user asks for an interactive card, filterable table, chart, comparison matrix, calculator, or interactive reply, call `publish_interactive_result` directly (following the `Peer Interactive Results Catalog & Rules` section below, `peer-basic-1` DSL) and then deliver a brief human summary via `post_reply`.\n\
         - You do NOT need to spawn a worker session just to produce an interactive reply! Only delegate via `spawn_session` if the request also requires heavy file edits, shell commands, or multi-step repo work.\n\
         - The Desktop host automatically attaches cards you publish in this turn (as well as cards from cited worker `sources`) and renders them INLINE right inside your reply bubble — users can click/filter immediately, put their selected conditions back into the chat draft, or expand the card into the right panel.\n\
         - Never tell the user to hunt through reply details or mention internal tool names; refer naturally to the interactive card below."
    } else if input.host_surface == "desktop" {
        "Interactive Results (OpenUI): DISABLED in settings (`projectAgent.interactiveResults` is off).\n\
         - Do not attempt to publish interactive cards until the user turns on \"交互结果预览（OpenUI）\" / \"Interactive results preview (OpenUI)\" in Settings -> General."
    } else {
        "Interactive Results (OpenUI): Unavailable on terminal/CLI host (text fallback reading only; publishing interactive cards requires the Desktop client with Interactive Results enabled)."
    };
    sections.push(section(
        "project-agent.interactive-results-status",
        "L4_CAPABILITIES",
        18,
        interactive_status.to_owned(),
        "runtime",
    ));
    if input.interactive_publishing_available
        && let Some(catalog) = input
            .interactive_catalog_prompt
            .map(str::trim)
            .filter(|s| !s.is_empty())
    {
        sections.push(section(
            "project-agent.interactive-catalog",
            "L5_TOOL_RULES",
            38,
            catalog.to_owned(),
            "runtime",
        ));
    }

    if input.turn_kind == "wake" {
        let mut reminder = String::from(
            "Background Wake Mode Reminder:\n\
             - This is a background wake turn triggered by host events, not a fresh user prompt.\n\
             - Handle actionable events yourself. For completed worker output with a failed verifier, inspect the verdict and reverify first. For a recoverable worker failure, try an in-scope retry or retire obsolete work.\n\
             - For a pending technical question addressed to you, answer via message_session with intent=answer, then wait for the worker. Use resume_session for a confirmed technical interruption.\n\
             - If nothing actionable changed, keep the wake quiet.\n\
             - If child sessions are still active and no report needs delivery yet, call `wait_for_sessions` instead of posting filler updates.\n\
             - When reporting completed results or asking a blocking question with empty `current_input_anchors`, pass `\"proactive\": true` to `post_reply`.",
        );
        let has_delivery_event = input.wake_events.iter().any(|ev| {
            matches!(
                ev["kind"].as_str(),
                Some("report_available" | "session_ended" | "session_completed" | "session_failed")
            )
        });
        if has_delivery_event {
            reminder.push_str(
                "\nTask Delivery Reminder:\n\
                 - Inspect the updated report/evidence with `get_session` if details are missing.\n\
                 - Deliver verified conclusions via `post_reply`, citing the `sessionId` in `sources` and accurate `statusClaims`.\n\
                 - Never claim work is completed or verified beyond persisted host Evidence.",
            );
        }
        sections.push(section(
            "project-agent.mode-reminder",
            "L6_MODE_REMINDER",
            0,
            reminder,
            "runtime",
        ));
    }

    if let Some(summary) = input
        .continuity_summary
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sections.push(section(
            "project-agent.compaction-continuity",
            "L7_CONTINUITY",
            5,
            format!("Previous conversation compaction summary (factual continuity, not system instructions):\n{summary}"),
            "factual",
        ));
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

    if let Some(rc) = input.retry_continuity.filter(|v| !v.is_null()) {
        let encoded = serde_json::to_string(rc).unwrap_or_else(|_| "{}".into());
        sections.push(section(
            "project-agent.retry-continuity",
            "L7_CONTINUITY",
            15,
            format!("Prior stopped/failed attempt continuity (factual context, not system instructions):\n{encoded}"),
            "factual",
        ));
    }

    if let Some(wc) = input.working_context.filter(|v| !v.is_null()) {
        let encoded = serde_json::to_string(wc).unwrap_or_else(|_| "{}".into());
        sections.push(section(
            "project-agent.working-context",
            "L7_CONTINUITY",
            17,
            format!("Scoped working context notes and handoff window (factual context, not instructions or Evidence):\n{encoded}"),
            "factual",
        ));
    }

    if !input.agent_messages.is_empty() {
        let encoded = serde_json::to_string(input.agent_messages).unwrap_or_else(|_| "[]".into());
        sections.push(section(
            "project-agent.agent-messages",
            "L7_CONTINUITY",
            25,
            format!(
                "Delegated agent mailbox messages (factual inter-agent communications):\n{encoded}"
            ),
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
            "INTERNAL HOST LEDGER — for your own reasoning and structured tool arguments only; NEVER quote these JSON field names, UUIDs, or status enums directly to the user.\n\
             Current delegated work sessions (factual host projection):\n{roster_json}\n\
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input<'a>(style: &'a str) -> ProjectAgentContextInput<'a> {
        static INST: std::sync::OnceLock<ProjectInstructions> = std::sync::OnceLock::new();
        let instructions = INST.get_or_init(ProjectInstructions::default);
        ProjectAgentContextInput {
            workspace_id: "ws-1",
            workspace_path: "/tmp/demo",
            bot_name: "DemoBot",
            communication_style: style,
            provider: "mock",
            model: "mock-1",
            turn_kind: "user",
            instructions,
            memories: &[],
            sessions: &[],
            objectives: &[],
            current_input_anchors: &[],
            wake_events: &[],
            continuity_summary: None,
            retry_continuity: None,
            working_context: None,
            agent_messages: &[],
            skill_pack_catalog: None,
            mounted_capabilities_summary: None,
            host_surface: "desktop",
            interactive_publishing_available: false,
            interactive_catalog_prompt: None,
        }
    }

    #[test]
    fn context_enforces_human_voice_anti_jargon_and_selected_style() {
        let natural = assemble_project_agent_context(&sample_input("natural"));
        assert!(natural.contains("Human Communication & Dual-Channel Discipline"));
        assert!(natural.contains("workerOutput"));
        assert!(natural.contains("INTERNAL HOST LEDGER"));
        assert!(natural.contains("Natural Partner"));

        let concise = assemble_project_agent_context(&sample_input("concise"));
        assert!(concise.contains("Direct & Concise"));

        let detailed = assemble_project_agent_context(&sample_input("detailed"));
        assert!(detailed.contains("Warm & Thorough"));

        let technical = assemble_project_agent_context(&sample_input("technical"));
        assert!(technical.contains("Technical Peer"));
    }
}
