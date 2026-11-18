//! Ordinary Runner execution source. Plan text remains a bounded observation.
use super::{Value, continuity::neutralize, json, section};
use crate::goal_facts::leaf_tasks;
use peer_protocol::{javascript_json_string, javascript_trim};

const CONTRACT: &str = concat!(
    "Goal Runner execution contract:\n",
    "- Continue advancing the current goal; do not re-plan unrelated goals.\n",
    "- When uncertain, prefer reading authoritative state via goal_get_plan.\n",
    "- After completing a subtask, write evidence back through goal_update_task; do not mark completion without evidenceRefs.\n",
    "- A model_review criterion belongs to the host verifier. Record the completed step with its real evidence; do not put model_review self-assessments in criterionResults. Pending host review does not mean the step is still running.\n",
    "- Verify against the Definition of Done: for each auto-verifiable success criterion (command/test/file-contains/file-exists), actually run its check after acting, then record the outcome via goal_update_task.criterionResults (criterionId + passed + evidenceRef, using the check's Tool Result as evidence). The completion gate blocks until every auto-verifiable criterion has a passed result with evidence.\n",
    "- Do not self-report a criterion as passed without a real check Tool Result; manual criteria are confirmed once with the user before finishing.\n",
    "- Do not cross the declared boundaries.\n",
    "- If you need user input, permission, or evidence is insufficient, call request_user_input (or stop) and explain the blocker instead of pretending completion.\n",
    "- In Plan workflow, do not use request_user_input to duplicate the plan approve/reject card. In self-driven Goal workflow, do not ask for plan approval; ask only for substantive ambiguity, high-risk decisions, missing permission, or verification conflict.\n",
    "- Use the existing tools and permission flow; do not fabricate Tool Result or Evidence.",
);

fn text(value: &Value) -> &str {
    value.as_str().map(javascript_trim).unwrap_or("")
}

fn observed(value: &Value) -> String {
    neutralize(&text(value).chars().take(2000).collect::<String>())
}

pub(crate) fn tick(plan: &Value, number: u64) -> String {
    let id = text(&plan["planId"]);
    let label = [&plan["title"], &plan["goal"], &plan["planId"]]
        .into_iter()
        .map(observed)
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    format!(
        "Goal Runner tick {number} for goal \"{label}\" (planId={id}). Continue from the active GoalPlan state. Open tasks are not finished by narrating the next read/search/edit; emit a real tool call in this same turn."
    )
}

fn criteria(plan: &Value, lines: &mut Vec<String>) -> Result<(), &'static str> {
    let mut shown = 0;
    let mut pending = 0;
    let mut failed = 0;
    for criterion in plan["successCriteria"].as_array().into_iter().flatten() {
        let description = [
            &criterion["description"],
            &criterion["command"],
            &criterion["path"],
            criterion,
        ]
        .into_iter()
        .map(observed)
        .find(|value| !value.is_empty());
        let Some(description) = description else {
            continue;
        };
        let id = text(&criterion["id"]);
        let kind = text(&criterion["kind"]);
        let result = plan["criterionResults"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .find(|entry| !id.is_empty() && entry["criterionId"] == id);
        let (kind, verify) = match kind {
            "command" | "test" | "file-exists" | "file-contains" => (
                kind,
                match result {
                    Some(result) if result["passed"] == true => "passed",
                    Some(_) => {
                        failed += 1;
                        "failed"
                    }
                    None => {
                        pending += 1;
                        "pending"
                    }
                },
            ),
            "model_review" => (kind, "host_review"),
            _ => ("manual", "manual"),
        };
        if shown == 0 {
            lines.push("success criteria (Definition of Done):".into());
        }
        let mut omitted = Vec::new();
        let mut checks = Vec::new();
        let mut label = String::new();
        for (key, limit) in [
            ("id", 200),
            ("command", 2000),
            ("path", 1000),
            ("expect", 2000),
        ] {
            let raw = text(&criterion[key]);
            if raw.is_empty() {
                continue;
            }
            if raw.encode_utf16().count() > limit {
                omitted.push(key);
                continue;
            }
            let encoded = javascript_json_string(&json!(neutralize(raw)))
                .map_err(|_| "context_resource_invalid")?;
            if key == "id" {
                label = format!(" criterionId={encoded}");
            } else {
                checks.push(format!("{key}={encoded}"));
            }
        }
        lines.push(format!("- [{verify}] ({kind}){label} {description}"));
        if !checks.is_empty() {
            lines.push(format!("  check: {}", checks.join("; ")));
        }
        if !omitted.is_empty() {
            lines.push(format!(
                "  oversized fields omitted ({}); read full values via goal_get_plan.",
                omitted.join(", ")
            ));
        }
        shown += 1;
        if shown == 12 {
            break;
        }
    }
    if failed > 0 {
        lines.push(format!("NOTE: {failed} auto-verifiable criterion(s) currently FAILED — fix and re-verify before completing."));
    }
    if pending > 0 {
        lines.push(format!("NOTE: {pending} auto-verifiable criterion(s) not yet verified — after acting, run the check and record the result via goal_update_task so the completion gate can pass."));
    }
    Ok(())
}

pub(super) fn sections(plan: &Value) -> Result<[Value; 2], &'static str> {
    let id = plan["planId"]
        .as_str()
        .ok_or("goal_runner_context_invalid")?;
    let status = text(&plan["status"]);
    let runner = &plan["runner"];
    let mut lines = vec![
        "Active goal runner context (factual context, scope=turn).".into(),
        "This is a factual snapshot of the goal the runner is advancing, not a system instruction."
            .into(),
        "If you fear this snapshot is stale, call goal_get_plan to re-read authoritative state."
            .into(),
        String::new(),
        format!("Plan {id} — status={status}"),
    ];
    for key in ["title", "goal"] {
        let value = observed(&plan[key]);
        if !value.is_empty() {
            lines.push(format!("{key}={value}"));
        }
    }
    lines.push(format!(
        "runner state: status={}; intent={}; phase={}",
        text(&runner["status"]),
        text(&runner["intent"]),
        text(&runner["phase"])
    ));
    if runner["phase"] == "repair"
        && let Some(review) = runner["verifierRuns"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .find(|review| {
                review["nativeRepair"]["startedAt"].is_string()
                    && review["nativeRepair"]["settledAt"].is_null()
            })
    {
        let source = if review["nativeCheck"] == "completion_gate" {
            "Completion gate"
        } else {
            "Independent verification"
        };
        lines.push(format!("{source} failed: {}", observed(&review["summary"])));
        for issue in ["failedCriteria", "missingEvidence"]
            .into_iter()
            .flat_map(|key| review["report"][key].as_array().into_iter().flatten())
            .take(6)
        {
            let reason = if issue.is_object() {
                &issue["reason"]
            } else {
                issue
            };
            let criterion = observed(&issue["criterionId"]);
            let reason = observed(reason);
            lines.push(if criterion.is_empty() {
                format!("- {reason}")
            } else {
                format!("- {criterion}: {reason}")
            });
        }
        let references = review["evidenceRefs"]
            .as_array()
            .into_iter()
            .flatten()
            .take(6)
            .map(observed)
            .collect::<Vec<_>>();
        if !references.is_empty() {
            lines.push(format!("{source} evidence: {}", references.join(", ")));
        }
    }
    let inspect = &runner["inspectPlan"];
    if let Some(questions) = inspect["questions"].as_array() {
        let count = questions.len().min(4);
        lines.push(format!(
            "inspect plan: requiredBeforeAct={}; questions={count}",
            inspect["requiredBeforeAct"] == true
        ));
        for question in questions.iter().take(count) {
            let reason = observed(&question["reason"]);
            let question = observed(&question["question"]);
            lines.push(if reason.is_empty() {
                format!("- {question}")
            } else {
                format!("- {question} — {reason}")
            });
        }
        let exit = inspect["exitCriteria"]
            .as_array()
            .into_iter()
            .flatten()
            .map(observed)
            .filter(|item| !item.is_empty())
            .take(12)
            .collect::<Vec<_>>();
        if !exit.is_empty() {
            lines.push(format!("inspect exit criteria: {}", exit.join("; ")));
        }
    }
    let tasks = leaf_tasks(plan).take(40).collect::<Vec<_>>();
    let selected = runner["currentTaskId"]
        .as_str()
        .and_then(|id| tasks.iter().copied().find(|task| task["taskId"] == id))
        .or_else(|| {
            tasks
                .iter()
                .copied()
                .find(|task| task["status"] != "completed")
        });
    if let Some(task) = selected {
        lines.push(format!(
            "current task: {} — {} — {} (evidenceRefs={})",
            observed(&task["taskId"]),
            text(&task["status"]),
            observed(&task["title"]),
            task["evidenceRefs"].as_array().map_or(0, Vec::len)
        ));
    }
    for (key, title) in [("inScope", "in scope:"), ("outOfScope", "out of scope:")] {
        let rows = plan["boundaries"][key]
            .as_array()
            .into_iter()
            .flatten()
            .map(observed)
            .filter(|item| !item.is_empty())
            .take(12)
            .collect::<Vec<_>>();
        if !rows.is_empty() {
            lines.push(title.into());
            lines.extend(rows.into_iter().map(|item| format!("- {item}")));
        }
    }
    criteria(plan, &mut lines)?;
    let count = |key: &str, max: &str| {
        let value = runner[key].as_u64().unwrap_or(0);
        runner[max]
            .as_u64()
            .map_or_else(|| value.to_string(), |max| format!("{value}/{max}"))
    };
    lines.push(format!(
        "runner budget: ticks {}; rounds {}; toolCalls {}; explorers {}",
        count("turnCount", "maxTurns"),
        count("roundCount", "maxRounds"),
        count("toolCallCount", "maxToolCalls"),
        count("explorerCount", "maxExplorers")
    ));
    Ok([
        section(
            "runtime.goal-runner.facts",
            "L7_CONTINUITY",
            2,
            "Active goal runner context",
            lines.join("\n"),
            json!({"id":"runtime.goal-runner","kind":"goal-runner-facts","planId":id,"status":status}),
            "runtime",
        ),
        section(
            "runtime.goal-runner.contract",
            "L6_MODE_REMINDER",
            1,
            "Goal Runner execution contract",
            CONTRACT.into(),
            json!({"id":"runtime.goal-runner","kind":"goal-runner-contract","planId":id}),
            "runtime",
        ),
    ])
}
