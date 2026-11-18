//! The existing Goal plan gate for ordinary explicit Goal mode.
use super::*;
use crate::{capability::ProviderPermission, goal_facts::TuiGoalProjector};
use peer_store::{GoalStore, LocalGoalIntake};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
pub(super) enum GoalIntake {
    NotRequired,
    Ready(LocalGoalIntake),
    Denied(&'static str),
}

impl GoalIntake {
    pub(super) fn denial(&self, home: &Path) -> Option<&'static str> {
        match self {
            Self::Denied(reason) => Some(reason),
            Self::Ready(intake) if GoalStore::new(home).check_local_intake(intake).is_err() => {
                Some("goal_intake_changed")
            }
            _ => None,
        }
    }
}

impl Host<'_> {
    pub(super) async fn observe_goal_intake(
        &mut self,
        permission: ProviderPermission,
    ) -> Result<GoalIntake, HostError> {
        if self.mode != RuntimeMode::Goal
            || !matches!(
                permission,
                ProviderPermission::FileWrite | ProviderPermission::Shell
            )
        {
            return Ok(GoalIntake::NotRequired);
        }

        let home = self.home.clone();
        let workspace = self.workspace.clone();
        let conversation = self.identity.conversation_id.clone();
        let projector = TuiGoalProjector::new(&now()).map_err(HostError)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let owner = self.owned.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            GoalStore::new(&home).observe_local_intake(
                &conversation,
                &workspace,
                &projector,
                Some(&flag),
            )
        });
        let observation = self
            .wait_owned(async {
                tokio::select! {
                    biased;
                    _ = owner.cancelled() => {
                        cancelled.store(true, Ordering::Release);
                        worker.await
                    }
                    result = &mut worker => result,
                }
            })
            .await?;
        self.source_current()?;
        Ok(match observation {
            Ok(Ok(Some(intake))) => GoalIntake::Ready(intake),
            Ok(Ok(None)) => GoalIntake::Denied("goal_intake_required"),
            _ => GoalIntake::Denied("goal_intake_unavailable"),
        })
    }
}
