use serde::{Deserialize, Serialize};

pub const WORKING_PLAN_SCHEMA_VERSION: u8 = 1;
pub const WORKING_PLAN_CAPABILITY: &str = "local.plan.update";
pub const WORKING_PLAN_TOOL_NAME: &str = "update_plan";

pub const MAX_WORKING_PLAN_STEPS: usize = 12;
pub const MAX_WORKING_PLAN_INVARIANTS: usize = 6;
pub const MAX_SUMMARY_CHARS: usize = 200;
pub const MAX_TITLE_CHARS: usize = 120;
pub const MAX_CHECK_CHARS: usize = 160;
pub const MAX_NOTE_CHARS: usize = 200;
pub const MAX_INVARIANT_CHARS: usize = 160;
pub const MAX_ARCHIVED_EPOCHS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkingPlanStepStatus {
    Pending,
    InProgress,
    Completed,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkingPlanStep {
    pub title: String,
    pub status: WorkingPlanStepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkingPlanInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub invariants: Vec<String>,
    pub steps: Vec<WorkingPlanStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchivedWorkingPlan {
    pub epoch: u64,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub completed: usize,
    pub total: usize,
    pub blocked: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open_titles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkingPlanSnapshot {
    pub schema_version: u8,
    pub conversation_id: String,
    pub epoch: u64,
    pub revision: u64,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub invariants: Vec<String>,
    pub steps: Vec<WorkingPlanStep>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archived: Vec<ArchivedWorkingPlan>,
}

pub fn validate_and_normalize_working_plan(
    mut input: WorkingPlanInput,
) -> Result<WorkingPlanInput, &'static str> {
    normalize_optional(&mut input.summary, MAX_SUMMARY_CHARS)?;
    if input.invariants.len() > MAX_WORKING_PLAN_INVARIANTS {
        return Err("working_plan_invariants_invalid");
    }
    for invariant in &mut input.invariants {
        normalize(invariant, MAX_INVARIANT_CHARS)?;
        if invariant.is_empty() {
            return Err("working_plan_invariants_invalid");
        }
    }
    if input.steps.is_empty() || input.steps.len() > MAX_WORKING_PLAN_STEPS {
        return Err("working_plan_steps_invalid");
    }
    let mut in_progress = 0;
    for step in &mut input.steps {
        normalize(&mut step.title, MAX_TITLE_CHARS)?;
        if step.title.is_empty() {
            return Err("working_plan_steps_invalid");
        }
        normalize_optional(&mut step.check, MAX_CHECK_CHARS)?;
        normalize_optional(&mut step.note, MAX_NOTE_CHARS)?;
        in_progress += usize::from(step.status == WorkingPlanStepStatus::InProgress);
    }
    if in_progress > 1 {
        return Err("working_plan_multiple_in_progress");
    }
    Ok(input)
}

fn normalize(value: &mut String, max: usize) -> Result<(), &'static str> {
    let trimmed = value.trim();
    if trimmed.chars().count() > max {
        return Err("working_plan_field_limit");
    }
    if trimmed.len() != value.len() {
        *value = trimmed.to_owned();
    }
    Ok(())
}

fn normalize_optional(value: &mut Option<String>, max: usize) -> Result<(), &'static str> {
    if let Some(text) = value {
        normalize(text, max)?;
        if text.is_empty() {
            *value = None;
        }
    }
    Ok(())
}

impl WorkingPlanStepStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Blocked => "blocked",
        }
    }
}

impl WorkingPlanSnapshot {
    pub fn open_steps(&self) -> Vec<&WorkingPlanStep> {
        self.steps
            .iter()
            .filter(|step| {
                matches!(
                    step.status,
                    WorkingPlanStepStatus::Pending | WorkingPlanStepStatus::InProgress
                )
            })
            .collect()
    }

    pub fn blocked_steps(&self) -> Vec<&WorkingPlanStep> {
        self.steps
            .iter()
            .filter(|step| step.status == WorkingPlanStepStatus::Blocked)
            .collect()
    }

    pub fn in_progress_step(&self) -> Option<&WorkingPlanStep> {
        self.steps
            .iter()
            .find(|step| step.status == WorkingPlanStepStatus::InProgress)
    }

    pub fn counts(&self) -> (usize, usize, usize) {
        let mut completed = 0;
        let mut blocked = 0;
        for step in &self.steps {
            completed += usize::from(step.status == WorkingPlanStepStatus::Completed);
            blocked += usize::from(step.status == WorkingPlanStepStatus::Blocked);
        }
        (completed, self.steps.len(), blocked)
    }

    pub fn to_archived_entry(&self) -> ArchivedWorkingPlan {
        let (completed, total, blocked) = self.counts();
        ArchivedWorkingPlan {
            epoch: self.epoch,
            updated_at: self.updated_at.clone(),
            summary: self.summary.clone(),
            completed,
            total,
            blocked,
            open_titles: self
                .steps
                .iter()
                .filter(|step| step.status != WorkingPlanStepStatus::Completed)
                .take(6)
                .map(|step| step.title.clone())
                .collect(),
        }
    }
}

pub fn format_working_plan_fact_block(snapshot: &WorkingPlanSnapshot) -> String {
    let mut lines = vec![format!(
        "Working plan snapshot (factual session state, epoch={}, revision={}; not a permission grant, not tool output, not completion evidence):",
        snapshot.epoch, snapshot.revision
    )];
    if let Some(summary) = &snapshot.summary {
        lines.push(format!("Summary: {summary}"));
    }
    if !snapshot.invariants.is_empty() {
        lines.push("Invariants (must preserve):".into());
        lines.extend(snapshot.invariants.iter().map(|item| format!("- {item}")));
    }
    if !snapshot.steps.is_empty() {
        lines.push("Steps:".into());
        for (index, step) in snapshot.steps.iter().enumerate() {
            let mut line = format!("- [{}] {}. {}", step.status.as_str(), index + 1, step.title);
            if let Some(check) = &step.check {
                line.push_str(&format!(" (check: {check})"));
            }
            if let Some(note) = &step.note {
                line.push_str(&format!(" [note: {note}]"));
            }
            lines.push(line);
        }
    } else if let Some(previous) = snapshot.archived.last() {
        lines.push(format!(
            "Most recent archived epoch {}: {}/{} completed, {} blocked (updated at {})",
            previous.epoch,
            previous.completed,
            previous.total,
            previous.blocked,
            previous.updated_at
        ));
        if let Some(summary) = &previous.summary {
            lines.push(format!("Summary: {summary}"));
        }
        if !previous.open_titles.is_empty() {
            lines.push("Unfinished steps from the archived epoch:".into());
            lines.extend(
                previous
                    .open_titles
                    .iter()
                    .map(|title| format!("- {title}")),
            );
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn working_plan_validation_enforces_bounds_and_single_in_progress() {
        let input = |steps| WorkingPlanInput {
            summary: Some(" ".into()),
            invariants: vec![" 保持边界 ".into()],
            steps,
        };
        let step = WorkingPlanStep {
            title: format!(" {} ", "查".repeat(MAX_TITLE_CHARS)),
            status: WorkingPlanStepStatus::InProgress,
            check: Some(" \t".into()),
            note: Some(" ".into()),
        };
        let normalized = validate_and_normalize_working_plan(input(vec![step.clone()])).unwrap();
        assert_eq!(normalized.steps[0].title, "查".repeat(MAX_TITLE_CHARS));
        assert_eq!(normalized.invariants, ["保持边界"]);
        assert_eq!(normalized.summary, None);
        assert_eq!(normalized.steps[0].check, None);
        assert_eq!(normalized.steps[0].note, None);
        assert_eq!(
            validate_and_normalize_working_plan(input(vec![])),
            Err("working_plan_steps_invalid")
        );
        assert_eq!(
            validate_and_normalize_working_plan(input(vec![step.clone(); 13])),
            Err("working_plan_steps_invalid")
        );
        assert_eq!(
            validate_and_normalize_working_plan(input(vec![step.clone(); 2])),
            Err("working_plan_multiple_in_progress")
        );
        let mut candidate = input(vec![step.clone()]);
        candidate.steps[0].title.push('验');
        assert_eq!(
            validate_and_normalize_working_plan(candidate),
            Err("working_plan_field_limit")
        );
        let mut candidate = input(vec![step]);
        candidate.invariants = vec!["边界".into(); 7];
        assert_eq!(
            validate_and_normalize_working_plan(candidate),
            Err("working_plan_invariants_invalid")
        );
    }
}
