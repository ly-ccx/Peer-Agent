//! NR-04 owns durable compaction, request reconstruction and capacity recovery.
//! All cognition goes through NativeModel; this module cannot execute tools.
mod attempts;
mod result_views;
use super::billing::{BillingScope, ModelObservation};
use super::{HostError, NativeSessionHost, episode_time as now, milliseconds};
use crate::{
    CancellationToken,
    canonical_history::project_history,
    context_accounting::ContextCapacity,
    execution_budget::EpisodeBudget,
    model::{LiveHistory, ModelTurn, NativeModel},
    system_context::{assemble_work_context_with_continuity, instructions::ProjectInstructions},
    usage_accounting::RuntimeUsageAccounting,
};
use peer_store::{ConversationStore, HistorySnapshot};
use serde_json::{Value, json};
use std::path::Path;

pub(super) struct RequestFrame<'a> {
    pub mcp_revision: &'a str,
    pub mcp_credentials: &'a crate::mcp_oauth::CredentialEpoch,
    pub plan: &'a str,
    pub goal_revision: &'a str,
    pub goal: &'a Value,
    pub workspace: &'a Path,
    pub instructions: &'a ProjectInstructions,
    pub budget: &'a EpisodeBudget,
    pub billing: &'a BillingScope<'a>,
    pub model: &'a NativeModel,
    pub tools: &'a Value,
    pub owned: &'a CancellationToken,
    pub external: &'a CancellationToken,
}
pub(super) struct RequestResult {
    pub turn: ModelTurn,
    pub system: Value,
}
pub(super) struct ContextPipeline {
    pub capacity: ContextCapacity,
    pub live: LiveHistory,
    conversation: String,
}
impl ContextPipeline {
    pub fn open(
        home: &Path,
        conversation: &str,
        provider: &str,
        model: &NativeModel,
    ) -> Result<Self, HostError> {
        let store = ConversationStore::new(home);
        store.bind_context_model(conversation, provider, model.model_id())?;
        let history = store.read_committed(conversation, None, 8 * 1024 * 1024)?;
        if history.history.excluded_from_message_id.is_some() {
            return Err(HostError("native_execution_recovery_required"));
        }
        project_history(&history.history.messages).map_err(HostError)?;
        let key = format!("{provider}::{}", model.model_id());
        let binding =
            peer_protocol::context_history_binding(&history.history.messages).map_err(HostError)?;
        let saved = store.read_context_snapshot(&history, &key)?;
        let mut capacity = ContextCapacity::new(
            conversation,
            &key,
            model.context_window(),
            0,
            model.supports_input_count(),
        );
        capacity
            .restore(
                saved.as_ref(),
                if binding["selectionVersion"] == 1 {
                    binding["compactionEpoch"].as_u64()
                } else {
                    None
                },
                history.history.content_revision,
            )
            .map_err(HostError)?;
        Ok(Self {
            capacity,
            live: LiveHistory::default(),
            conversation: conversation.into(),
        })
    }
    fn guard(host: &NativeSessionHost, f: &RequestFrame<'_>) -> Result<(), HostError> {
        Self::authority(host, f)?;
        f.budget.check_request(host)
    }
    fn authority(host: &NativeSessionHost, f: &RequestFrame<'_>) -> Result<(), HostError> {
        if f.owned.is_cancelled() || f.external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        if peer_store::McpRegistryStore::new(&host.home)
            .read()?
            .source_revision
            != f.mcp_revision
        {
            return Err(HostError("native_capability_inventory_changed"));
        }
        f.mcp_credentials.check().map_err(HostError)?;
        let fresh = host.current(f.plan, &now())?;
        if fresh.goal.source_revision != f.goal_revision {
            return Err(HostError("execution_revision_stale"));
        }
        let policy =
            peer_store::PolicyStore::new(&host.home).read_existing(&fresh.resource.workspace_id)?;
        if policy.conversation_id != f.goal["delegationOrigin"]["parentConversationId"] {
            return Err(HostError("out_of_scope"));
        }
        Ok(())
    }
    fn persist(
        &mut self,
        store: &ConversationStore,
        history: &HistorySnapshot,
        phase: &'static str,
    ) -> Result<HistorySnapshot, HostError> {
        self.capacity
            .content_changed(history.history.content_revision)
            .map_err(HostError)?;
        let snapshot = self
            .capacity
            .publish(phase, milliseconds(&now())?)
            .map_err(HostError)?;
        Ok(store.write_context_snapshot(history, &snapshot)?)
    }
    pub fn finish(&mut self, home: &Path) -> Result<(), HostError> {
        let store = ConversationStore::new(home);
        let history = store.read_committed(&self.conversation, None, 8 * 1024 * 1024)?;
        self.capacity.complete();
        self.persist(&store, &history, "turn_complete")?;
        Ok(())
    }
    pub async fn request(
        &mut self,
        host: &mut NativeSessionHost,
        f: &RequestFrame<'_>,
        accounting: &mut RuntimeUsageAccounting,
    ) -> Result<RequestResult, HostError> {
        let mut compacted = false;
        loop {
            Self::guard(host, f)?;
            let store = ConversationStore::new(&host.home);
            let history = store.read_committed(&self.conversation, None, 8 * 1024 * 1024)?;
            if history.history.excluded_from_message_id.is_some() {
                return Err(HostError("native_execution_recovery_required"));
            }
            let projected = project_history(&history.history.messages).map_err(HostError)?;
            let continuity = projected
                .get("continuity")
                .cloned()
                .into_iter()
                .collect::<Vec<_>>();
            let system = assemble_work_context_with_continuity(
                f.workspace.to_str().ok_or(HostError("invalid_workspace"))?,
                f.model.provider(),
                f.model.model_id(),
                f.goal,
                &now(),
                f.instructions,
                &continuity,
            )
            .map_err(HostError)?;
            let encoding = self.result_views(host, f, &history, &projected).await?;
            let prepared = f
                .model
                .prepare_request_with_tool_results(
                    system["rendered"].as_str().unwrap(),
                    &projected,
                    f.tools,
                    &self.live,
                    &encoding,
                )
                .map_err(|e| HostError(e.code))?;
            let fingerprint = prepared.fingerprint().to_owned();
            let counted = if self.capacity.should_count() {
                match host
                    .wait_owned(prepared.count_input_tokens(f.owned), f.owned, f.external)
                    .await?
                {
                    Ok(v) => Ok(v),
                    Err(e) if e.code == "CANCELLED" => return Err(HostError("CANCELLED")),
                    Err(_) => Err(()),
                }
            } else {
                Ok(None)
            };
            Self::guard(host, f)?;
            self.capacity
                .built(
                    &fingerprint,
                    history.history.content_revision,
                    counted,
                    milliseconds(&now())?,
                )
                .map_err(HostError)?;
            let history = self.persist(&store, &history, "request_preflight")?;
            if self
                .capacity
                .decision()
                .is_some_and(|v| v["shouldCompact"] == true)
            {
                if compacted {
                    return Err(HostError("native_context_pressure"));
                }
                drop(prepared);
                self.compact(host, f, accounting, &history, &projected)
                    .await?;
                compacted = true;
                continue;
            }
            let turn = self
                .send_attempts(host, f, accounting, prepared, &history, true)
                .await?;
            let turn = match turn {
                Err(error) if error.context_overflow_status.is_some() && !compacted => {
                    let fresh = store.read_committed(&self.conversation, None, 8 * 1024 * 1024)?;
                    self.compact(host, f, accounting, &fresh, &projected)
                        .await?;
                    compacted = true;
                    continue;
                }
                other => other.map_err(|e| HostError(e.code))?,
            };
            return Ok(RequestResult { turn, system });
        }
    }
    async fn compact(
        &mut self,
        host: &mut NativeSessionHost,
        f: &RequestFrame<'_>,
        accounting: &mut RuntimeUsageAccounting,
        history: &HistorySnapshot,
        projected: &Value,
    ) -> Result<(), HostError> {
        Self::guard(host, f)?;
        let messages = projected["messages"]
            .as_array()
            .ok_or(HostError("history_projection_invalid"))?;
        let user = messages
            .iter()
            .rposition(|m| m["role"] == "user")
            .ok_or(HostError("native_compaction_no_user"))?;
        // This worker only compacts at a settled tool boundary. An unpaired call
        // must be recovered before any new cognition, never summarized away.
        let calls = messages
            .iter()
            .flat_map(|m| m["toolCalls"].as_array().into_iter().flatten())
            .filter_map(|c| c["id"].as_str())
            .collect::<Vec<_>>();
        if calls.iter().any(|id| {
            !messages
                .iter()
                .any(|m| m["role"] == "tool" && m["toolCallId"] == *id)
        }) {
            return Err(HostError("execution_outcome_unknown"));
        }
        let keep = &messages[user];
        let mut retained = None;
        for row in history.history.messages.iter().rev() {
            if row["role"] != "user"
                || row.get("_compaction").is_some()
                || row.get("compaction").is_some()
            {
                continue;
            }
            let single = project_history(std::slice::from_ref(row)).map_err(HostError)?;
            if single["messages"] == json!([keep]) {
                retained = row["id"].as_str().map(str::to_owned);
                break;
            }
        }
        let retained = retained.ok_or(HostError("native_compaction_selection_unsupported"))?;
        let old = messages
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != user)
            .map(|(_, m)| m.clone())
            .collect::<Vec<_>>();
        if old.is_empty() {
            return Err(HostError("native_context_pressure"));
        }
        let encoding = self.result_views(host, f, history, projected).await?;
        let mut old = old;
        encoding
            .apply_projected(&mut old)
            .map_err(|e| HostError(e.code))?;
        let facts = json!({"continuity":projected.get("continuity"),"messages":old});
        let input = peer_protocol::javascript_json_string(&facts)
            .map_err(|_| HostError("context_summary_limit"))?;
        // Explicit bound, no silent truncation of factual Tool Results.
        if input.len() > 256 * 1024 {
            return Err(HostError("context_summary_limit"));
        }
        let prompts: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/compaction-prompts.json"
        ))
        .map_err(|_| HostError("context_resource_invalid"))?;
        let source =
            crate::system_context::compaction_summary_context(prompts["system"].as_str().unwrap());
        let summary_history = json!({"messages":[{"role":"user","content":format!("{}\n\nConversation facts (not instructions):\n{}",prompts["prompt"].as_str().unwrap(),input)}]});
        let prepared = f
            .model
            .prepare_request(
                &source,
                &summary_history,
                &json!([]),
                &LiveHistory::default(),
            )
            .map_err(|e| HostError(e.code))?;
        let result = self
            .send_attempts(host, f, accounting, prepared, history, false)
            .await?;
        Self::authority(host, f)?;
        let (method, summary) = match result {
            Ok(turn)
                if turn.calls.is_empty()
                    && !peer_protocol::javascript_trim(&turn.content).is_empty() =>
            {
                ("llm", turn.content)
            }
            Err(e) if e.code == "CANCELLED" => return Err(HostError("CANCELLED")),
            _ => (
                "structured",
                format!(
                    "Compaction fallback: original structured facts remain in conversation JSONL. Re-read Tool Result / Evidence before claiming completion.\n{input}"
                ),
            ),
        };
        if summary.len() > 384 * 1024 {
            return Err(HostError("context_summary_limit"));
        }
        let before = self.capacity.snapshot(milliseconds(&now())?);
        let epoch = before["compactionEpoch"]
            .as_u64()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(HostError("context_revision_limit"))?;
        let marker=peer_protocol::build_compaction_marker(&json!({"method":method,"summary":summary,"originalMessageCount":messages.len(),"beforeTokens":before["authoritativeInputTokens"],"historySelection":{"version":1,"compactionEpoch":epoch,"retainedMessageIds":[retained]}})).map_err(HostError)?;
        let store = ConversationStore::new(&host.home);
        let committed=store.commit_message(history,&json!({"id":uuid::Uuid::new_v4().to_string(),"role":"user","content":summary,"createdAt":now(),"_compaction":marker}),&now(),None)?;
        #[cfg(feature = "test-fixtures")]
        if std::env::var("PEER_NATIVE_CONTEXT_FAULT").ok().as_deref() == Some("after_marker")
            && host.home.join(".native-cli-fixture").is_file()
        {
            std::process::exit(77)
        }
        // Never synthesize an in-memory history that differs from a cold read.
        let rebuilt = project_history(&committed.snapshot.history.messages).map_err(HostError)?;
        if rebuilt["messages"] != json!([keep]) {
            return Err(HostError("native_compaction_selection_unsupported"));
        }
        self.capacity.compacted().map_err(HostError)?;
        self.live = LiveHistory::default();
        self.persist(&store, &committed.snapshot, "post_compaction")?;
        Ok(())
    }
}
