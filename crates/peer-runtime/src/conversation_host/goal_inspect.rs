//! Headless Goal intake schedules the existing read-only Explorer when the
//! canonical plan needs repository grounding.
use super::*;
use crate::goal_facts::leaf_tasks;
use crate::providers::goal::{CREATE_CAPABILITY, explorer::ExplorerRequest};
use peer_store::{AutomaticInspect, GoalStore, LocalGoalIntake};
use std::collections::HashSet;

fn strings(values: &Value) -> impl Iterator<Item = &str> {
    values
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(peer_protocol::javascript_trim)
        .filter(|item| !item.is_empty())
}

fn unique<'a>(values: impl Iterator<Item = &'a str>) -> impl Iterator<Item = &'a str> {
    let mut seen = HashSet::new();
    values.filter(move |value| seen.insert(*value))
}

fn questions(plan: &Value) -> Vec<Value> {
    if plan["runner"]["explorers"]
        .as_array()
        .is_some_and(|workers| {
            workers
                .iter()
                .any(|worker| worker["status"] == "completed" && worker["report"].is_object())
        })
    {
        return Vec::new();
    }
    let leaves = leaf_tasks(plan).collect::<Vec<_>>();
    let known = unique(
        strings(&plan["involvedFiles"]).chain(
            leaves
                .iter()
                .flat_map(|task| strings(&task["involvedFiles"])),
        ),
    )
    .collect::<Vec<_>>();
    let target = plan["targetWorkspacePath"]
        .as_str()
        .map(peer_protocol::javascript_trim)
        .filter(|s| !s.is_empty());
    let automatic_criterion = plan["successCriteria"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["kind"].as_str().is_some_and(|kind| kind != "manual"))
    });
    let needs_grounding = (target.is_some() || automatic_criterion || leaves.len() >= 4)
        && leaves
            .iter()
            .any(|task| task["involvedFiles"].as_array().is_none_or(Vec::is_empty));
    let needs_verification_path = automatic_criterion && known.is_empty();
    let include = unique(
        target
            .into_iter()
            .chain(strings(&plan["boundaries"]["inScope"]))
            .chain(known.iter().copied()),
    )
    .take(12)
    .collect::<Vec<_>>();
    let exclude = unique(strings(&plan["boundaries"]["outOfScope"]))
        .take(12)
        .collect::<Vec<_>>();
    let mut scope = serde_json::Map::new();
    if !include.is_empty() {
        scope.insert("include".into(), json!(include));
    }
    if !exclude.is_empty() {
        scope.insert("exclude".into(), json!(exclude));
    }
    let question = |question: &str, reason: &str| {
        let mut request = json!({"question": question, "reason": reason});
        if !scope.is_empty() {
            request["scope"] = Value::Object(scope.clone());
        }
        request
    };
    let mut requests = Vec::new();
    if needs_grounding {
        let label = target
            .or_else(|| {
                [&plan["title"], &plan["goal"]]
                    .into_iter()
                    .filter_map(Value::as_str)
                    .map(peer_protocol::javascript_trim)
                    .find(|text| !text.is_empty())
            })
            .unwrap_or("the target workspace");
        requests.push(question(
            &format!("Identify the primary files, modules, and existing implementation paths needed before acting on: {label}"),
            "Deterministic inspect requires repository context and task-to-file grounding before act.",
        ));
    }
    if needs_verification_path {
        requests.push(question(
            "Identify the read-only verification path for the automatic success criteria before acting.",
            "Deterministic inspect requires a verifiable test/check path before act.",
        ));
    }
    requests
}

impl Host<'_> {
    pub(super) fn newly_created_goal(&self) -> Result<Option<LocalGoalIntake>, HostError> {
        let new_goals = explorer::settled_parent_calls(
            &self.expected,
            &self.identity.stream_id,
            CREATE_CAPABILITY,
        )
        .filter_map(|(call, segment)| {
            let id = call.strip_prefix("call-")?;
            let output = &segment["result"]["output"];
            (output["ok"] == true && output["planId"] == id).then_some(id)
        })
        .collect::<HashSet<_>>();
        if new_goals.is_empty() {
            return Ok(None);
        }
        let store = GoalStore::new(&self.home);
        let projector = crate::goal_facts::TuiGoalProjector::new(&now()).map_err(HostError)?;
        Ok(store.observe_runner_intake(
            &self.identity.conversation_id,
            &self.workspace,
            &projector,
            &new_goals,
        )?)
    }

    pub(super) async fn drive_deterministic_inspect(
        &mut self,
        mut goal: LocalGoalIntake,
        plan: &Value,
    ) -> Result<bool, HostError> {
        let questions = questions(plan);
        if questions.is_empty() {
            return Ok(false);
        }
        let requests = questions
            .iter()
            .map(ExplorerRequest::parse)
            .collect::<Result<Vec<_>, _>>()?;
        let scheduled = questions.into_iter().map(|mut question| {
            question["budget"] = json!({"maxToolCalls":peer_store::EXPLORER_TOOL_LIMIT,"maxDurationMs":peer_store::EXPLORER_TIMEOUT_MS});
            question
        }).collect::<Vec<_>>();
        let schedule = json!({"requiredBeforeAct": true, "questions": scheduled,
            "exitCriteria": [
                "primary modules/files identified or an Explorer report explains why they cannot be identified yet",
                "automatic verification path identified when automatic success criteria exist",
                "remaining unknowns are explicit and acceptable before act",
            ], "generatedAt": now()});
        for request in requests {
            goal = self
                .run_requested_explorer(
                    &format!("inspect-{}", uuid::Uuid::new_v4()),
                    request,
                    Some(AutomaticInspect {
                        goal: &goal,
                        schedule: &schedule,
                    }),
                )
                .await?
                .ok_or(HostError("explorer_goal_changed"))?;
        }
        GoalStore::new(&self.home).check_local_intake(&goal)?;
        Ok(true)
    }
}
