//! Per-conversation fingerprints of context sections received by the model.

use serde_json::Value;
use std::{collections::HashMap, sync::Mutex, time::Duration};

pub const CONTEXT_READ_TIMEOUT_MS: u64 = 1_500;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SectionFingerprints {
    pub memories: Option<String>,
    pub objectives: Option<String>,
    pub working_context: Option<String>,
    pub skill_packs: Option<String>,
    pub mounted_capabilities: Option<String>,
}

#[derive(Default)]
pub struct SessionContextTracker {
    inner: Mutex<HashMap<String, (u64, SectionFingerprints)>>,
}

impl SessionContextTracker {
    pub fn prior(&self, conversation_id: &str, compaction_epoch: u64) -> SectionFingerprints {
        self.inner
            .lock()
            .ok()
            .and_then(|saved| {
                saved
                    .get(conversation_id)
                    .filter(|(epoch, _)| *epoch == compaction_epoch)
                    .map(|(_, value)| value.clone())
            })
            .unwrap_or_default()
    }

    pub fn commit(
        &self,
        conversation_id: &str,
        compaction_epoch: u64,
        fingerprints: SectionFingerprints,
    ) {
        if let Ok(mut saved) = self.inner.lock()
            && saved
                .get(conversation_id)
                .is_none_or(|(epoch, _)| *epoch <= compaction_epoch)
        {
            saved.insert(conversation_id.to_owned(), (compaction_epoch, fingerprints));
        }
    }
}

pub(crate) fn render_delta(
    sections: &mut [Value],
    prior: &SectionFingerprints,
    counts: &[(&str, usize)],
) -> SectionFingerprints {
    let mut current = SectionFingerprints::default();
    for section in sections {
        let (previous, next, label) = match section["id"].as_str() {
            Some("project-agent.memory") => (&prior.memories, &mut current.memories, "memories"),
            Some("project-agent.objectives") => {
                (&prior.objectives, &mut current.objectives, "objectives")
            }
            Some("project-agent.working-context") => (
                &prior.working_context,
                &mut current.working_context,
                "working_context",
            ),
            Some("project-agent.skill-packs") => {
                (&prior.skill_packs, &mut current.skill_packs, "skill_packs")
            }
            Some("project-agent.mounted-capabilities") => (
                &prior.mounted_capabilities,
                &mut current.mounted_capabilities,
                "mounted_capabilities",
            ),
            _ => continue,
        };
        let Some(content) = section["content"].as_str() else {
            continue;
        };
        let digest = crate::sha256_hex(content.as_bytes());
        if previous.as_ref() == Some(&digest) {
            let count = counts
                .iter()
                .find(|(name, _)| *name == label)
                .map_or(0, |(_, count)| *count);
            section["content"] = Value::String(format!(
                "Unchanged since prior turn in this conversation: {label} ({count} items). Refer to earlier context."
            ));
        }
        *next = Some(digest);
    }
    current
}

pub(crate) async fn read_context<T: Send + 'static>(
    source: &'static str,
    read: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    match tokio::time::timeout(
        Duration::from_millis(CONTEXT_READ_TIMEOUT_MS),
        tokio::task::spawn_blocking(read),
    )
    .await
    {
        Ok(Ok(value)) => Some(value),
        _ => {
            eprintln!("project-agent context read degraded: {source}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test(start_paused = true)]
    async fn blocked_external_context_source_degrades_at_the_deadline() {
        let (release, blocked) = std::sync::mpsc::channel();
        let (started, waiting) = tokio::sync::oneshot::channel();
        let read = tokio::spawn(read_context("test", move || {
            started.send(()).unwrap();
            blocked.recv()
        }));
        waiting.await.unwrap();
        tokio::time::advance(Duration::from_millis(CONTEXT_READ_TIMEOUT_MS - 1)).await;
        assert!(!read.is_finished());
        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(read.await.unwrap().is_none());
        release.send("late data").unwrap();
    }

    #[test]
    fn context_tracker_emits_delta_on_unchanged_sections_and_resets_on_compaction() {
        let tracker = SessionContextTracker::default();
        let render = |epoch, memory: &str, objectives: &str| {
            let mut sections = [
                json!({"id": "project-agent.memory", "content": memory}),
                json!({"id": "project-agent.objectives", "content": objectives}),
                json!({"id": "project-agent.roster", "content": "Live worker roster"}),
            ];
            let snapshot = render_delta(
                &mut sections,
                &tracker.prior("conversation", epoch),
                &[("memories", 2), ("objectives", 1)],
            );
            (sections, snapshot)
        };
        let (first, fingerprint) = render(0, "Memory facts", "Objective A");
        assert_eq!(first[0]["content"], "Memory facts");
        assert_eq!(
            render(0, "Memory facts", "Objective A").0[0]["content"],
            "Memory facts"
        );
        tracker.commit("conversation", 0, fingerprint);
        let (next, fingerprint) = render(0, "Memory facts", "Objective B");
        assert_eq!(
            next[0]["content"],
            "Unchanged since prior turn in this conversation: memories (2 items). Refer to earlier context."
        );
        assert_eq!(next[1]["content"], "Objective B");
        assert_eq!(next[2]["content"], "Live worker roster");
        tracker.commit("conversation", 0, fingerprint);
        let (compacted, _) = render(1, "Memory facts", "Objective B");
        assert_eq!(compacted[0]["content"], "Memory facts");
        assert_eq!(compacted[1]["content"], "Objective B");
    }
}
