//! Governed Main Bot, worker & verifier CapabilityProvider for OpenUI interactive results
//! (`local.interactive.publish` and `local.interactive.inspect`, ADR 118).
//!
//! - `project_agent` (when enabled on Desktop host): projects ONLY `publish_interactive_result`
//!   (`inspect_interactive_result` is already registered on `ProjectCapabilityProvider`), writing
//!   only to the Bot's internal result space with canonical `bot-reply:<turnId>` source identity.
//! - `session_worker` (when enabled on Desktop host): projects both `publish_interactive_result`
//!   and `inspect_interactive_result`, even on `readOnly: true` tasks (internal publication
//!   exception per ADR 118 §9.1).
//! - `verifier` / `visual_verifier`: projects ONLY `inspect_interactive_result`, never publish.
//! - OpenUI DSL validation and pure evaluation delegate to `InteractiveContentBridge`
//!   (mounted by Desktop over reverse RPC), keeping CLI/TUI free of JS/OpenUI dependencies.

use crate::{
    INTERACTIVE_INSPECT_CAPABILITY, INTERACTIVE_INSPECT_TOOL, InteractiveContentBridge,
    InteractiveResultStore, ValidatedPublicationRequest, interactive_results, now_iso,
};
use peer_protocol::{
    ExecutionResourceScope,
    interactive_result::{
        INTERACTIVE_FALLBACK_BYTES, INTERACTIVE_MANIFEST_BYTES, INTERACTIVE_PUBLISH_CAPABILITY,
        INTERACTIVE_PUBLISH_TOOL, InteractiveOwner, InteractiveResultReference,
        InteractiveResultSource, interactive_canonical_json, interactive_digest,
        interactive_json_digest, interactive_token,
    },
};
use peer_runtime::{
    CancellationToken,
    capability::{CapabilityError as HostError, ProviderPermission, ShellRisk},
    providers::{
        CapabilityProvider, EffectAdmission, EffectFuture, EffectOutcome, PreparedEffect,
        ProviderCall, ToolOutputKind,
    },
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

pub const INTERACTIVE_READ_RULES: &str = "Peer interactive result inspection. Use only projected inspect_interactive_result and an admitted fixed result/publication reference. Main Bot reads metadata/text only; worker/Verifier may read fixed program/data and bounded pure evaluation. User conditions must be explicitly admitted frozen followups, never latest UI state. Keep source classification, version, redaction and truncation. Pending/unknown publication requires original-call reconciliation, never reexecution or new publication. Read/compute Evidence is not source business truth, task verification or acceptance. Interactive controls do not grant execution, permission or canonical user input. Existing report, verification and post_reply paths retain authority.";

const MAX_REPAIR_FAILURES: usize = 3; // initial attempt + at most 2 repairs
const MAX_INPUT_BINDINGS: usize = 16;
const MAX_INPUT_BYTES: usize = 512 * 1024;
const DATA_LEVELS: [&str; 5] = [
    "D0_public",
    "D1_internal",
    "D2_sensitive",
    "D3_private",
    "D4_regulated",
];

fn level_rank(level: &str) -> Option<usize> {
    DATA_LEVELS.iter().position(|&l| l == level)
}

fn max_level(a: &str, b: &str) -> &'static str {
    let ra = level_rank(a).unwrap_or(3);
    let rb = level_rank(b).unwrap_or(3);
    DATA_LEVELS[ra.max(rb)]
}

fn valid_binding_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn publish_schema() -> Value {
    let token = json!({ "type": "string", "minLength": 1, "maxLength": 256 });
    let digest = json!({ "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" });
    let owner = json!({
        "type": "object",
        "properties": { "workspaceId": token, "conversationId": token },
        "required": ["workspaceId", "conversationId"],
        "additionalProperties": false
    });
    let reference = json!({
        "type": "object",
        "properties": { "owner": owner, "resultId": token, "contentVersion": digest },
        "required": ["owner", "resultId", "contentVersion"],
        "additionalProperties": false
    });
    let selector = json!({
        "type": "object",
        "properties": {
            "path": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
            "fields": { "type": "array", "items": { "type": "string" }, "maxItems": 32 },
            "start": { "type": "integer", "minimum": 0, "maximum": 500 },
            "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
        },
        "additionalProperties": false
    });
    json!({
        "type": "object",
        "properties": {
            "publication": {
                "oneOf": [
                    {
                        "type": "object",
                        "properties": { "kind": { "const": "create" } },
                        "required": ["kind"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": { "kind": { "const": "revise" }, "base": reference },
                        "required": ["kind", "base"],
                        "additionalProperties": false
                    }
                ]
            },
            "title": { "type": "string", "minLength": 1, "maxLength": 160 },
            "textFallback": { "type": "string", "minLength": 1, "maxLength": 32768 },
            "program": { "type": "string", "minLength": 1, "maxLength": 65536 },
            "inputs": {
                "type": "array",
                "maxItems": 16,
                "items": {
                    "type": "object",
                    "properties": {
                        "bindingId": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
                        "selector": selector,
                        "source": {
                            "oneOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "kind": { "const": "tool-result" },
                                        "conversationId": token,
                                        "toolCallId": token,
                                        "expectedContentVersion": digest
                                    },
                                    "required": ["kind", "conversationId", "toolCallId", "expectedContentVersion"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "kind": { "const": "user-material" },
                                        "messageId": token,
                                        "attachmentId": token,
                                        "expectedContentVersion": digest
                                    },
                                    "required": ["kind", "messageId", "attachmentId", "expectedContentVersion"],
                                    "additionalProperties": false
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "kind": { "const": "model-data" },
                                        "value": { "description": "Bounded JSON; always model-constructed, never observed Evidence." }
                                    },
                                    "required": ["kind", "value"],
                                    "additionalProperties": false
                                }
                            ]
                        }
                    },
                    "required": ["bindingId", "source"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["publication", "title", "textFallback", "program", "inputs"],
        "additionalProperties": false
    })
}

fn inspect_schema() -> Value {
    let token = json!({ "type": "string", "minLength": 1, "maxLength": 256 });
    let digest = json!({ "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" });
    let owner = json!({
        "type": "object",
        "properties": { "workspaceId": token, "conversationId": token },
        "required": ["workspaceId", "conversationId"],
        "additionalProperties": false
    });
    let reference = json!({
        "type": "object",
        "properties": { "owner": owner, "resultId": token, "contentVersion": digest },
        "required": ["owner", "resultId", "contentVersion"],
        "additionalProperties": false
    });
    let call_reference = json!({
        "type": "object",
        "properties": { "owner": owner, "conversationId": token, "toolCallId": token },
        "required": ["owner", "conversationId", "toolCallId"],
        "additionalProperties": false
    });
    let selector = json!({
        "type": "object",
        "properties": {
            "path": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
            "fields": { "type": "array", "items": { "type": "string" }, "maxItems": 32 },
            "start": { "type": "integer", "minimum": 0, "maximum": 500 },
            "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
        },
        "additionalProperties": false
    });
    json!({
        "type": "object",
        "properties": {
            "target": {
                "oneOf": [
                    {
                        "type": "object",
                        "properties": { "kind": { "const": "result" }, "reference": reference },
                        "required": ["kind", "reference"],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": { "kind": { "const": "publication" }, "reference": call_reference },
                        "required": ["kind", "reference"],
                        "additionalProperties": false
                    }
                ]
            },
            "view": {
                "type": "string",
                "enum": ["metadata", "text", "program", "data", "evaluate"],
                "description": "Use a result target for program, data or evaluate. Publication targets only support metadata."
            },
            "bindingId": { "type": "string", "minLength": 1, "maxLength": 256 },
            "selector": selector,
            "followupId": { "type": "string", "minLength": 1, "maxLength": 256 },
            "offset": { "type": "integer", "minimum": 0, "maximum": MAX_INPUT_BYTES },
            "limit": { "type": "integer", "minimum": 1, "maximum": 4000 }
        },
        "required": ["target", "view"],
        "additionalProperties": false
    })
}

/// Builds the `L5_TOOL_RULES` context extension JSON for `peer-runtime` ordinary context assembly.
pub fn interactive_context_extension(
    bridge: Option<&dyn InteractiveContentBridge>,
    can_publish: bool,
) -> Value {
    let content = if can_publish {
        bridge
            .and_then(|b| b.catalog_prompt())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| INTERACTIVE_READ_RULES.to_owned())
    } else {
        INTERACTIVE_READ_RULES.to_owned()
    };
    json!({
        "id": "interactive-results",
        "title": "Peer Interactive Results Catalog & Rules",
        "layer": "L5_TOOL_RULES",
        "priority": 38,
        "sourceKind": "registered-catalog",
        "trust": "builtin",
        "content": content,
    })
}

#[derive(Clone)]
pub struct WorkSessionInteractiveContext {
    pub data_home: PathBuf,
    pub owner: InteractiveOwner,
    pub plan_id: String,
    pub session_id: String,
    pub plan_conversation_id: String,
    pub execution_epoch: String,
    pub role: String,
    pub can_publish: bool,
    pub bridge: Arc<dyn InteractiveContentBridge>,
    pub on_published: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

pub struct WorkSessionInteractiveProvider {
    ctx: WorkSessionInteractiveContext,
    repair_failures: Arc<AtomicUsize>,
}

impl WorkSessionInteractiveProvider {
    pub fn new(ctx: WorkSessionInteractiveContext) -> Self {
        Self {
            ctx,
            repair_failures: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn allows_publish(&self) -> bool {
        self.ctx.can_publish
            && matches!(self.ctx.role.as_str(), "session_worker" | "project_agent")
    }
}

impl CapabilityProvider for WorkSessionInteractiveProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        let mut out = Vec::new();
        if self.allows_publish() {
            out.push((
                INTERACTIVE_PUBLISH_TOOL.to_owned(),
                json!({
                    "capabilityId": INTERACTIVE_PUBLISH_CAPABILITY,
                    "name": INTERACTIVE_PUBLISH_TOOL,
                    "description": "Publish a bounded Peer interactive result (OpenUI card, filterable table, chart, or calculator) as an internal user artifact of this project Bot. Use only the current admitted catalog, fixed materials or model-data, and an explicit create or revise base. In Desktop, published cards render inline inside your reply bubble and can expand into the side panel. This does not write project files, run commands, refresh external data, approve actions, or complete a task. Model data stays labelled as assumptions.",
                    "source": "native",
                    "riskLevel": "L2_local_write",
                    "dataLevel": "D2_sensitive",
                    "health": "available",
                    "modeScopes": ["chat", "goal", "project_agent"],
                    "inputSchema": publish_schema(),
                }),
            ));
        }
        // Main Bot (`project_agent`) already registers `inspect_interactive_result` on
        // `ProjectCapabilityProvider`; avoid duplicate tool registration in the same registry.
        if self.ctx.role != "project_agent" {
            out.push((
                INTERACTIVE_INSPECT_TOOL.to_owned(),
                json!({
                    "capabilityId": INTERACTIVE_INSPECT_CAPABILITY,
                    "name": INTERACTIVE_INSPECT_TOOL,
                    "description": "Read an admitted fixed result or original publication receipt. Workers and Verifiers can inspect metadata, fallback text, actual program, selected data bindings, and bounded pure evaluation.",
                    "source": "native",
                    "riskLevel": "L1_local_read",
                    "dataLevel": "D2_sensitive",
                    "health": "available",
                    "modeScopes": ["chat", "goal"],
                    "inputSchema": inspect_schema(),
                }),
            ));
        }
        out
    }

    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        _workspace: &Path,
        _home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if !args.is_object()
            || serde_json::to_vec(&args)
                .map_err(|_| HostError("tool_arguments_invalid"))?
                .len()
                > INTERACTIVE_MANIFEST_BYTES
        {
            return Err(HostError("tool_arguments_invalid"));
        }
        match capability {
            cap if cap == INTERACTIVE_PUBLISH_CAPABILITY => {
                if !self.allows_publish() {
                    return Err(HostError("tool_not_projected"));
                }
                Ok(Box::new(InteractiveEffect {
                    capability: INTERACTIVE_PUBLISH_CAPABILITY,
                    args,
                    ctx: self.ctx.clone(),
                    repair_failures: Arc::clone(&self.repair_failures),
                    port: None,
                    projection_id: None,
                }))
            }
            cap if cap == INTERACTIVE_INSPECT_CAPABILITY && self.ctx.role != "project_agent" => {
                Ok(Box::new(InteractiveEffect {
                    capability: INTERACTIVE_INSPECT_CAPABILITY,
                    args,
                    ctx: self.ctx.clone(),
                    repair_failures: Arc::clone(&self.repair_failures),
                    port: None,
                    projection_id: None,
                }))
            }
            _ => Err(HostError("tool_not_projected")),
        }
    }
}

struct InteractiveEffect {
    capability: &'static str,
    args: Value,
    ctx: WorkSessionInteractiveContext,
    repair_failures: Arc<AtomicUsize>,
    port: Option<EffectAdmission>,
    projection_id: Option<String>,
}

impl PreparedEffect for InteractiveEffect {
    fn output_kind(&self) -> ToolOutputKind {
        ToolOutputKind::Structured
    }

    fn admission(&mut self, port: EffectAdmission) {
        self.port = Some(port);
    }

    fn evidence(&self) -> Option<Value> {
        Some(json!({
            "evidenceKind": "interactive_result",
            "capabilityId": self.capability,
            "projectionId": self.projection_id,
        }))
    }

    fn projection(&mut self, id: &str) {
        self.projection_id = Some(id.to_owned());
    }

    fn args(&self) -> &Value {
        &self.args
    }

    fn permission(&self) -> ProviderPermission {
        if self.capability == INTERACTIVE_PUBLISH_CAPABILITY {
            ProviderPermission::External
        } else {
            ProviderPermission::Read
        }
    }

    fn risk(&self) -> Option<ShellRisk> {
        Some(if self.capability == INTERACTIVE_PUBLISH_CAPABILITY {
            ShellRisk::LocalWrite
        } else {
            ShellRisk::LocalRead
        })
    }

    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }

    fn start(
        self: Box<Self>,
        call: ProviderCall,
        cancel: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        let port = self.port;
        let capability = self.capability;
        let args = self.args;
        let ctx = self.ctx;
        let repair_failures = self.repair_failures;
        let tool_call_id = call.tool_call_id().to_owned();
        let worker_conversation_id = call.conversation_id().to_owned();

        Ok(Box::pin(async move {
            let Some(port) = port else {
                return EffectOutcome::not_dispatched("execution_admission_closed");
            };
            if let Err(err) = port.check().await {
                return EffectOutcome::not_dispatched(err.0);
            }
            if cancel.is_cancelled() {
                return EffectOutcome::not_dispatched("CANCELLED");
            }

            if capability == INTERACTIVE_PUBLISH_CAPABILITY {
                run_publish(
                    &ctx,
                    &args,
                    &tool_call_id,
                    "",
                    &worker_conversation_id,
                    &repair_failures,
                    cancel,
                )
                .await
            } else {
                run_inspect(&ctx, &args, cancel).await
            }
        }))
    }
}

fn failed_publish_outcome(
    code: &str,
    path: &str,
    details: &str,
    remaining_repairs: Option<usize>,
) -> EffectOutcome {
    let mut diagnostic = json!({
        "code": code,
        "path": path.chars().take(240).collect::<String>(),
        "details": details.chars().take(240).collect::<String>(),
        "retryable": false,
    });
    if let Some(remaining) = remaining_repairs {
        diagnostic["repair"] = json!({
            "kind": "new_candidate",
            "remaining": remaining,
        });
    }
    EffectOutcome {
        status: "failed",
        output: json!({
            "kind": "interactive_publication",
            "publicationStatus": "not_committed",
            "diagnostic": diagnostic,
        }),
        error: Some("interactive_validation_failed"),
        artifacts: vec![],
        ended: true,
        materialization: None,
        not_dispatched: false,
    }
}

fn normalize_draft(raw: &Value) -> Result<(Value, String, Option<InteractiveResultReference>), &'static str> {
    let obj = raw.as_object().ok_or("interactive_draft_invalid")?;
    for key in obj.keys() {
        if !matches!(
            key.as_str(),
            "publication" | "title" | "textFallback" | "program" | "inputs"
        ) {
            return Err("interactive_draft_invalid");
        }
    }
    let pub_obj = obj
        .get("publication")
        .and_then(Value::as_object)
        .ok_or("interactive_draft_invalid")?;
    let pub_kind = pub_obj
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("interactive_draft_invalid")?;
    let (normalized_pub, base_ref) = match pub_kind {
        "create" => {
            if pub_obj.len() != 1 {
                return Err("interactive_draft_invalid");
            }
            (json!({ "kind": "create" }), None)
        }
        "revise" => {
            if pub_obj.len() != 2 {
                return Err("interactive_draft_invalid");
            }
            let base: InteractiveResultReference =
                serde_json::from_value(pub_obj.get("base").cloned().ok_or("interactive_draft_invalid")?)
                    .map_err(|_| "interactive_draft_invalid")?;
            if !base.is_valid() {
                return Err("interactive_draft_invalid");
            }
            (json!({ "kind": "revise", "base": base }), Some(base))
        }
        _ => return Err("interactive_draft_invalid"),
    };

    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 160 && !s.contains('\0'))
        .ok_or("interactive_draft_invalid")?;
    let text_fallback = obj
        .get("textFallback")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= INTERACTIVE_FALLBACK_BYTES && !s.contains('\0'))
        .ok_or("interactive_draft_invalid")?;
    let program = obj
        .get("program")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 64 * 1024 && !s.contains('\0'))
        .ok_or("interactive_draft_invalid")?;
    let inputs = obj
        .get("inputs")
        .and_then(Value::as_array)
        .filter(|a| a.len() <= MAX_INPUT_BINDINGS)
        .ok_or("interactive_draft_invalid")?;

    let mut seen_bindings = HashSet::new();
    let mut normalized_inputs = Vec::with_capacity(inputs.len());
    for item in inputs {
        let item_obj = item.as_object().ok_or("interactive_draft_invalid")?;
        for key in item_obj.keys() {
            if !matches!(key.as_str(), "bindingId" | "source" | "selector") {
                return Err("interactive_draft_invalid");
            }
        }
        let binding_id = item_obj
            .get("bindingId")
            .and_then(Value::as_str)
            .filter(|s| valid_binding_id(s))
            .ok_or("interactive_draft_invalid")?;
        if !seen_bindings.insert(binding_id.to_owned()) {
            return Err("invalid_binding");
        }
        let src_obj = item_obj
            .get("source")
            .and_then(Value::as_object)
            .ok_or("interactive_draft_invalid")?;
        let src_kind = src_obj
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("interactive_draft_invalid")?;
        let normalized_source = match src_kind {
            "model-data" => {
                if !src_obj.contains_key("value") || src_obj.len() != 2 {
                    return Err("interactive_draft_invalid");
                }
                json!({ "kind": "model-data", "value": src_obj["value"] })
            }
            "tool-result" => {
                let cid = src_obj
                    .get("conversationId")
                    .and_then(Value::as_str)
                    .filter(|s| interactive_token(s))
                    .ok_or("interactive_draft_invalid")?;
                let tid = src_obj
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|s| interactive_token(s))
                    .ok_or("interactive_draft_invalid")?;
                let ver = src_obj
                    .get("expectedContentVersion")
                    .and_then(Value::as_str)
                    .filter(|s| interactive_digest(s))
                    .ok_or("interactive_draft_invalid")?;
                json!({
                    "kind": "tool-result",
                    "conversationId": cid,
                    "toolCallId": tid,
                    "expectedContentVersion": ver,
                })
            }
            "user-material" => {
                let mid = src_obj
                    .get("messageId")
                    .and_then(Value::as_str)
                    .filter(|s| interactive_token(s))
                    .ok_or("interactive_draft_invalid")?;
                let aid = src_obj
                    .get("attachmentId")
                    .and_then(Value::as_str)
                    .filter(|s| interactive_token(s))
                    .ok_or("interactive_draft_invalid")?;
                let ver = src_obj
                    .get("expectedContentVersion")
                    .and_then(Value::as_str)
                    .filter(|s| interactive_digest(s))
                    .ok_or("interactive_draft_invalid")?;
                json!({
                    "kind": "user-material",
                    "messageId": mid,
                    "attachmentId": aid,
                    "expectedContentVersion": ver,
                })
            }
            _ => return Err("interactive_draft_invalid"),
        };
        let mut entry = json!({
            "bindingId": binding_id,
            "source": normalized_source,
        });
        if let Some(sel) = item_obj.get("selector").filter(|v| !v.is_null()) {
            if !sel.is_object() {
                return Err("interactive_draft_invalid");
            }
            entry["selector"] = sel.clone();
        }
        normalized_inputs.push(entry);
    }

    let draft = json!({
        "publication": normalized_pub,
        "title": title,
        "textFallback": text_fallback,
        "program": program,
        "inputs": normalized_inputs,
    });
    Ok((draft, pub_kind.to_owned(), base_ref))
}

async fn run_publish(
    ctx: &WorkSessionInteractiveContext,
    args: &Value,
    tool_call_id: &str,
    stream_id: &str,
    worker_conversation_id: &str,
    repair_failures: &AtomicUsize,
    cancel: CancellationToken,
) -> EffectOutcome {
    let store = InteractiveResultStore::new(&ctx.data_home);
    let (normalized_draft, pub_kind, base_ref) = match normalize_draft(args) {
        Ok(v) => v,
        Err(code) => return failed_publish_outcome(code, "", "Invalid interactive result draft", None),
    };

    if let Some(ref base) = base_ref
        && base.owner != ctx.owner
    {
        return failed_publish_outcome("interactive_scope_denied", "publication.base", "Base owner mismatch", None);
    }

    let args_digest = match interactive_json_digest(&normalized_draft) {
        Ok(d) => d,
        Err(_) => return failed_publish_outcome("interactive_draft_invalid", "", "Cannot digest draft", None),
    };

    // Idempotent replay / reconcile check for the same tool call ID
    if let Ok(Some(prior)) =
        store.get_operation(&ctx.owner, &ctx.plan_conversation_id, tool_call_id)
    {
        if prior["argsDigest"].as_str() != Some(args_digest.as_str()) {
            return failed_publish_outcome(
                "publication_parameter_conflict",
                "",
                "Call ID already committed with different parameters",
                None,
            );
        }
        let _ = store.reconcile_pending(&ctx.owner);
        if let Ok(Some(refreshed)) =
            store.get_operation(&ctx.owner, &ctx.plan_conversation_id, tool_call_id)
            && refreshed["publicationStatus"].as_str() == Some("published")
        {
            return build_published_outcome(ctx, &store, &refreshed);
        }
        return failed_publish_outcome(
            "publication_index_pending",
            "",
            "Publication committed but EvidenceIndex reconciliation pending",
            None,
        );
    }

    let inherited_level = match store.owner_data_level(&ctx.owner, "D3_private") {
        Ok(l) => l,
        Err(e) => return failed_publish_outcome(e.code, "", &e.detail, None),
    };

    let mut bindings = serde_json::Map::new();
    let mut provenance = Vec::new();
    let mut total_bytes: usize = 0;
    let mut effective_level = inherited_level.clone();

    for input in normalized_draft["inputs"].as_array().into_iter().flatten() {
        let binding_id = input["bindingId"].as_str().unwrap_or("");
        let source = &input["source"];
        let selector = input.get("selector");
        let kind = source["kind"].as_str().unwrap_or("");
        let observed_at = now_iso();

        let (raw_value, source_meta, content_version, data_level, truncated, redacted, ev_refs) =
            match kind {
                "model-data" => {
                    let val = source["value"].clone();
                    let body = match interactive_canonical_json(&val) {
                        Ok(s) => s,
                        Err(_) => {
                            return failed_publish_outcome(
                                "invalid_binding",
                                &format!("inputs.{binding_id}"),
                                "Non-finite or invalid JSON in model-data",
                                None,
                            );
                        }
                    };
                    let ver = match interactive_json_digest(&val) {
                        Ok(d) => d,
                        Err(_) => {
                            return failed_publish_outcome(
                                "invalid_binding",
                                &format!("inputs.{binding_id}"),
                                "Cannot digest model-data",
                                None,
                            );
                        }
                    };
                    let _ = body;
                    (
                        val,
                        json!({ "kind": "model-data", "contentDigest": ver }),
                        ver,
                        inherited_level.clone(),
                        false,
                        false,
                        Vec::<Value>::new(),
                    )
                }
                "tool-result" => {
                    let cid = source["conversationId"].as_str().unwrap_or("");
                    let tid = source["toolCallId"].as_str().unwrap_or("");
                    let exp = source["expectedContentVersion"].as_str().unwrap_or("");
                    if cid != ctx.plan_conversation_id && cid != worker_conversation_id {
                        return failed_publish_outcome(
                            "material_scope_denied",
                            &format!("inputs.{binding_id}"),
                            "Tool result source outside current work session",
                            None,
                        );
                    }
                    let mat = match store.read_material(&ctx.owner, cid, tid, exp) {
                        Ok(Some(m)) => m,
                        Ok(None) => {
                            return failed_publish_outcome(
                                "material_snapshot_unavailable",
                                &format!("inputs.{binding_id}"),
                                "Tool observation snapshot not found",
                                None,
                            );
                        }
                        Err(e) => {
                            return failed_publish_outcome(
                                e.code,
                                &format!("inputs.{binding_id}"),
                                &e.detail,
                                None,
                            );
                        }
                    };
                    let lvl = mat["dataLevel"]
                        .as_str()
                        .unwrap_or(&inherited_level)
                        .to_owned();
                    let trunc = mat["truncated"].as_bool().unwrap_or(false);
                    let red = mat["redacted"].as_bool().unwrap_or(false);
                    let refs = mat["evidenceRefs"].as_array().cloned().unwrap_or_default();
                    (
                        mat["value"].clone(),
                        source.clone(),
                        exp.to_owned(),
                        lvl,
                        trunc,
                        red,
                        refs,
                    )
                }
                _ => {
                    return failed_publish_outcome(
                        "material_snapshot_unavailable",
                        &format!("inputs.{binding_id}"),
                        "Material source unavailable on current host",
                        None,
                    );
                }
            };

        let selected = match interactive_results::select_interactive_data(&raw_value, selector) {
            Ok(v) => v,
            Err(e) => {
                return failed_publish_outcome(
                    e.code,
                    &format!("inputs.{binding_id}"),
                    "Selector out of bounds",
                    None,
                );
            }
        };
        let selected_encoded = match interactive_canonical_json(&selected) {
            Ok(s) => s,
            Err(_) => {
                return failed_publish_outcome(
                    "invalid_binding",
                    &format!("inputs.{binding_id}"),
                    "Cannot encode selected data",
                    None,
                );
            }
        };
        total_bytes = total_bytes.saturating_add(selected_encoded.len());
        if total_bytes > MAX_INPUT_BYTES {
            return failed_publish_outcome(
                "interactive_resource_limit",
                &format!("inputs.{binding_id}"),
                "Input snapshot size exceeds 512 KiB limit",
                None,
            );
        }
        let selected_digest = match interactive_json_digest(&selected) {
            Ok(d) => d,
            Err(_) => {
                return failed_publish_outcome(
                    "invalid_binding",
                    &format!("inputs.{binding_id}"),
                    "Cannot digest selected data",
                    None,
                );
            }
        };
        effective_level = max_level(&effective_level, &data_level).to_owned();
        bindings.insert(binding_id.to_owned(), selected);
        let mut prov_row = json!({
            "bindingId": binding_id,
            "source": source_meta,
            "contentVersion": content_version,
            "selectedDigest": selected_digest,
            "observedAt": observed_at,
            "capturedAt": now_iso(),
            "truncated": truncated,
            "redacted": redacted,
            "dataLevel": data_level,
            "evidenceRefs": ev_refs,
        });
        if let Some(sel) = selector.filter(|v| v.is_object()) {
            prov_row["selector"] = sel.clone();
        }
        provenance.push(prov_row);
    }

    // Enforce bounded content repair budget per worker session
    let current_failures = repair_failures.load(Ordering::SeqCst);
    if current_failures >= MAX_REPAIR_FAILURES {
        return failed_publish_outcome(
            "interactive_repair_limit_exceeded",
            "",
            "Maximum interactive result content repair attempts reached for this work session",
            Some(0),
        );
    }

    // Validate OpenUI DSL program & bindings via Desktop `@peer-agent/interactive-content`
    let validated_content = match ctx
        .bridge
        .validate_draft(
            normalized_draft.clone(),
            Value::Object(bindings),
            cancel.clone(),
        )
        .await
    {
        Ok(content) => content,
        Err(err) => {
            let next_failures = repair_failures.fetch_add(1, Ordering::SeqCst) + 1;
            let remaining = MAX_REPAIR_FAILURES.saturating_sub(next_failures);
            return failed_publish_outcome(&err.code, &err.path, &err.details, Some(remaining));
        }
    };

    if cancel.is_cancelled() {
        return EffectOutcome::not_dispatched("CANCELLED");
    }

    let final_level = match store.owner_data_level(&ctx.owner, &effective_level) {
        Ok(l) => l,
        Err(e) => return failed_publish_outcome(e.code, "", &e.detail, None),
    };

    let grant_id = format!("grant-ir-{tool_call_id}");
    let commit_req = ValidatedPublicationRequest {
        owner: ctx.owner.clone(),
        source: InteractiveResultSource {
            conversation_id: ctx.plan_conversation_id.clone(),
            plan_id: ctx.plan_id.clone(),
            session_id: ctx.session_id.clone(),
            tool_call_id: tool_call_id.to_owned(),
            execution_epoch: Some(ctx.execution_epoch.clone()),
        },
        publication_kind: pub_kind,
        base: base_ref,
        normalized_draft,
        validated_content,
        provenance,
        data_level: final_level,
        grant_id,
        stream_id: (!stream_id.is_empty()).then(|| stream_id.to_owned()),
    };

    let receipt = match store.commit_validated_publication(&commit_req, true) {
        Ok(r) => r,
        Err(e) => return failed_publish_outcome(e.code, "", &e.detail, None),
    };

    if receipt["publicationStatus"].as_str() == Some("published") {
        return build_published_outcome(ctx, &store, &receipt);
    }

    // Durably reconcile pending publication into `goal-plans/evidence-index.jsonl`
    match store.reconcile_pending(&ctx.owner) {
        Ok(_) => {
            if let Ok(Some(final_receipt)) =
                store.get_operation(&ctx.owner, &ctx.plan_conversation_id, tool_call_id)
                && final_receipt["publicationStatus"].as_str() == Some("published")
            {
                return build_published_outcome(ctx, &store, &final_receipt);
            }
            EffectOutcome {
                status: "failed",
                output: json!({
                    "kind": "interactive_publication",
                    "publicationStatus": "index_pending",
                    "effectCommitted": true,
                    "callRef": receipt["callRef"],
                    "reference": receipt["reference"],
                    "recovery": "reconcile_only",
                    "diagnostic": { "code": "publication_index_pending", "path": "", "details": "Committed; reconcile pending", "retryable": false }
                }),
                error: Some("publication_index_pending"),
                artifacts: vec![],
                ended: true,
                materialization: None,
                not_dispatched: false,
            }
        }
        Err(e) => EffectOutcome {
            status: "failed",
            output: json!({
                "kind": "interactive_publication",
                "publicationStatus": "index_pending",
                "effectCommitted": true,
                "callRef": receipt["callRef"],
                "reference": receipt["reference"],
                "recovery": "reconcile_only",
                "diagnostic": { "code": e.code, "path": "", "details": e.detail, "retryable": false }
            }),
            error: Some("publication_index_pending"),
            artifacts: vec![],
            ended: true,
            materialization: None,
            not_dispatched: false,
        },
    }
}

fn build_published_outcome(
    ctx: &WorkSessionInteractiveContext,
    store: &InteractiveResultStore,
    receipt: &Value,
) -> EffectOutcome {
    let ref_obj: Option<InteractiveResultReference> =
        serde_json::from_value(receipt["reference"].clone()).ok();
    let version = ref_obj
        .as_ref()
        .and_then(|r| store.get_version(r, false).ok());
    let artifact_ref = version
        .as_ref()
        .and_then(|v| v["artifactRef"].as_str())
        .or_else(|| receipt["metadata"]["artifactRef"].as_str())
        .or_else(|| receipt["artifactRef"].as_str())
        .unwrap_or("")
        .to_owned();
    if !artifact_ref.is_empty()
        && let Some(cb) = &ctx.on_published
    {
        cb(artifact_ref.clone());
    }
    let title = version
        .as_ref()
        .and_then(|v| v["content"]["title"].as_str())
        .unwrap_or("")
        .to_owned();
    let text_fallback = version
        .as_ref()
        .and_then(|v| v["content"]["textFallback"].as_str())
        .unwrap_or("")
        .to_owned();
    let mut output = json!({
        "kind": "interactive_publication",
        "publicationStatus": "published",
        "reference": receipt["reference"],
        "callRef": receipt["callRef"],
        "artifactRef": artifact_ref,
        "title": title,
        "textFallback": text_fallback,
    });
    if receipt["unchanged"] == true {
        output["unchanged"] = json!(true);
    }
    // IMPORTANT: Keep `artifacts` empty here because `reconcile_pending` already durably
    // registered the canonical `interactive-result://...` EvidenceIndex row with `planId`,
    // `conversationId = plan.conversationId`, `createdAt`, and `userArtifacts`. Leaving
    // `artifacts` empty prevents `conversation_host::tool` from registering a second
    // worker-conversation-scoped merge over the canonical interactive evidence row.
    EffectOutcome {
        status: "success",
        output,
        error: None,
        artifacts: vec![],
        ended: true,
        materialization: None,
        not_dispatched: false,
    }
}

async fn run_inspect(
    ctx: &WorkSessionInteractiveContext,
    args: &Value,
    cancel: CancellationToken,
) -> EffectOutcome {
    let store = InteractiveResultStore::new(&ctx.data_home);
    if args["target"]["kind"].as_str() == Some("publication") {
        let _ = store.reconcile_pending(&ctx.owner);
    }

    // For `evaluate` view, run real bounded OpenUI pure evaluation via Desktop bridge!
    if args["view"].as_str() == Some("evaluate")
        && args["target"]["kind"].as_str() == Some("result")
        && let Ok(reference) =
            serde_json::from_value::<InteractiveResultReference>(args["target"]["reference"].clone())
    {
        if !reference.is_valid() || reference.owner != ctx.owner {
            return EffectOutcome {
                status: "failed",
                output: json!({ "error": "interactive_scope_denied" }),
                error: Some("interactive_scope_denied"),
                artifacts: vec![],
                ended: true,
                materialization: None,
                not_dispatched: false,
            };
        }
        let fixed = match store.get_version(&reference, false) {
            Ok(v) => v,
            Err(e) => {
                return EffectOutcome {
                    status: "failed",
                    output: json!({ "error": e.code, "detail": e.detail }),
                    error: Some("interactive_result_unavailable"),
                    artifacts: vec![],
                    ended: true,
                    materialization: None,
                    not_dispatched: false,
                };
            }
        };
        let content = fixed["content"].clone();
        let values = content["initialValues"].clone();
        let state_digest = interactive_json_digest(&values).unwrap_or_default();
        match ctx.bridge.evaluate_content(content.clone(), values.clone(), cancel).await {
            Ok(eval_res) => {
                let text = eval_res["projection"]["text"].as_str().unwrap_or("");
                let comp_trunc = eval_res["projection"]["truncated"].as_bool().unwrap_or(false);
                let paged = match interactive_results::page_interactive_text(
                    text,
                    args["offset"].as_u64(),
                    args["limit"].as_u64(),
                ) {
                    Ok(p) => p,
                    Err(e) => {
                        return EffectOutcome {
                            status: "failed",
                            output: json!({ "error": e.code }),
                            error: Some("interactive_range_exceeded"),
                            artifacts: vec![],
                            ended: true,
                            materialization: None,
                            not_dispatched: false,
                        };
                    }
                };
                let mut out = json!({
                    "kind": "interactive_inspection",
                    "reference": fixed["reference"],
                    "specHash": content["specHash"],
                    "view": "evaluate",
                    "dataLevel": fixed["dataLevel"],
                    "source": fixed["source"],
                    "evidenceRef": fixed["evidenceRef"],
                    "classification": "host-derived",
                    "stateSource": { "kind": "initial", "values": values, "stateDigest": state_digest },
                    "computationTruncated": comp_trunc,
                    "notice": "Pure computation is not verification of source business facts or task acceptance.",
                });
                for (k, v) in paged.as_object().into_iter().flatten() {
                    out[k] = v.clone();
                }
                return EffectOutcome {
                    status: "success",
                    output: out,
                    error: None,
                    artifacts: vec![],
                    ended: true,
                    materialization: None,
                    not_dispatched: false,
                };
            }
            Err(err) => {
                return EffectOutcome {
                    status: "failed",
                    output: json!({
                        "error": err.code,
                        "path": err.path,
                        "details": err.details,
                    }),
                    error: Some("interactive_validation_failed"),
                    artifacts: vec![],
                    ended: true,
                    materialization: None,
                    not_dispatched: false,
                };
            }
        }
    }

    match store.inspect_for_role(&ctx.role, &ctx.owner, args) {
        Ok(out) => EffectOutcome {
            status: "success",
            output: out,
            error: None,
            artifacts: vec![],
            ended: true,
            materialization: None,
            not_dispatched: false,
        },
        Err(e) => EffectOutcome {
            status: "failed",
            output: json!({ "error": e.code, "detail": e.detail }),
            error: Some("interactive_inspect_failed"),
            artifacts: vec![],
            ended: true,
            materialization: None,
            not_dispatched: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        BotProfileStore, CreateBotProfile, InteractiveValidationError, SessionSupervisor,
        SpawnCriterion, SpawnSessionRequest, verifier::resolve_work_session_profile_with_interactive,
    };
    use peer_protocol::HostSurface;
    use peer_store::EvidenceIndexStore;
    use std::pin::Pin;
    use tempfile::tempdir;

    struct FakeOpenUiBridge {
        fail_first: AtomicUsize,
    }

    impl InteractiveContentBridge for FakeOpenUiBridge {
        fn validate_draft(
            &self,
            draft: Value,
            bindings: Value,
            _cancel: CancellationToken,
        ) -> Pin<
            Box<dyn std::future::Future<Output = Result<Value, InteractiveValidationError>> + Send>,
        > {
            let attempt = self.fail_first.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if attempt == 0 && draft["program"].as_str() == Some("BROKEN") {
                    return Err(InteractiveValidationError::new(
                        "invalid_program",
                        "program",
                        "Expected root= assignment",
                    ));
                }
                Ok(json!({
                    "schemaVersion": 1,
                    "libraryVersion": "peer-basic-1",
                    "title": draft["title"],
                    "textFallback": draft["textFallback"],
                    "program": draft["program"],
                    "specHash": "sha256:37505cc28779ca4e18facf09edb86db7a01a64d58b0acc22841b168707dc3d24",
                    "stateSchemaHash": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
                    "stateSchema": { "status": { "type": "string" } },
                    "initialValues": { "status": "all" },
                    "bindings": bindings,
                }))
            })
        }

        fn evaluate_content(
            &self,
            content: Value,
            values: Value,
            _cancel: CancellationToken,
        ) -> Pin<
            Box<dyn std::future::Future<Output = Result<Value, InteractiveValidationError>> + Send>,
        > {
            Box::pin(async move {
                Ok(json!({
                    "projection": {
                        "text": format!("Evaluated {} with {}", content["title"].as_str().unwrap_or(""), values),
                        "truncated": false
                    }
                }))
            })
        }

        fn catalog_prompt(&self) -> Option<String> {
            Some("Peer interactive result language (peer-basic-1)".to_owned())
        }
    }

    fn spawn_req(ws_id: &str, ws_path: &Path, read_only: bool, caps: Vec<&str>) -> SpawnSessionRequest {
        SpawnSessionRequest {
            workspace_id: ws_id.to_owned(),
            workspace_path: ws_path.to_path_buf(),
            parent_conversation_id: "conv-bot-1".to_owned(),
            anchor_message_ids: vec!["input-1".to_owned()],
            input_id: "1".to_owned(),
            surface: "desktop".to_owned(),
            title: "Demo OpenUI Card".to_owned(),
            brief: "Publish a filterable OpenUI card".to_owned(),
            kind: "ui".to_owned(),
            read_only,
            required_capabilities: caps.into_iter().map(str::to_owned).collect(),
            success_criteria: vec![SpawnCriterion {
                id: Some("c-1".into()),
                kind: "model_review".into(),
                description: "Publish valid interactive result".into(),
                command: None,
                path: None,
                expect: None,
            }],
            priority: "normal".to_owned(),
            depends_on: vec![],
            supersedes: None,
            objective_id: None,
            isolation: "none".to_owned(),
            worker_model_selection: json!({}),
        }
    }

    #[test]
    fn pre_dispatch_gates_tui_disabled_desktop_and_admits_readonly_desktop_worker() {
        let dir = tempdir().unwrap();
        let ws = tempdir().unwrap();
        let profiles = BotProfileStore::new(dir.path());
        profiles
            .create(&CreateBotProfile {
                workspace_id: "ws-ir-gate",
                display_name: "GateBot",
                agent_conversation_id: "conv-bot-1",
                managed: true,
                avatar_salt: "ws-ir-gate",
            })
            .unwrap();

        // 1. TUI surface rejects interactive publish before spawning.
        let tui_sup = SessionSupervisor::new_for_surface(dir.path(), HostSurface::Tui, Some(1));
        let err = tui_sup
            .spawn_session(
                spawn_req(
                    "ws-ir-gate",
                    ws.path(),
                    true,
                    vec![INTERACTIVE_PUBLISH_CAPABILITY, INTERACTIVE_INSPECT_CAPABILITY],
                ),
                true,
            )
            .unwrap_err();
        assert_eq!(err.code, "capability_not_available");
        assert!(err.detail.contains("Desktop"));

        // 2. Desktop surface with setting OFF rejects interactive publish before spawning.
        let desk_sup =
            SessionSupervisor::new_for_surface(dir.path(), HostSurface::Desktop, Some(1));
        desk_sup.set_interactive_bridge(Some(Arc::new(FakeOpenUiBridge {
            fail_first: AtomicUsize::new(0),
        })));
        let err_off = desk_sup
            .spawn_session(
                spawn_req(
                    "ws-ir-gate",
                    ws.path(),
                    true,
                    vec![INTERACTIVE_PUBLISH_CAPABILITY],
                ),
                true,
            )
            .unwrap_err();
        assert_eq!(err_off.code, "capability_not_available");
        assert!(err_off.detail.contains("interactiveResults"));

        // 3. Desktop surface with setting ON admits readOnly=true worker (ADR 118 §9.1)
        //    and gives verifier inspect-only rights (never publish).
        desk_sup.set_interactive_enabled_override(Some(true));
        let summary = desk_sup
            .spawn_session(
                spawn_req(
                    "ws-ir-gate",
                    ws.path(),
                    true,
                    vec![INTERACTIVE_PUBLISH_CAPABILITY, INTERACTIVE_INSPECT_CAPABILITY],
                ),
                true,
            )
            .unwrap();
        let plan = desk_sup
            .find_plan_by_session("ws-ir-gate", &summary.session_id)
            .unwrap();

        let worker_profile =
            resolve_work_session_profile_with_interactive(&plan, "worker", true).unwrap();
        assert!(worker_profile.read_only);
        assert!(
            worker_profile
                .allowlist
                .contains(&INTERACTIVE_PUBLISH_CAPABILITY.to_owned())
        );
        assert!(
            worker_profile
                .allowlist
                .contains(&INTERACTIVE_INSPECT_CAPABILITY.to_owned())
        );

        let verifier_profile =
            resolve_work_session_profile_with_interactive(&plan, "verifier", true).unwrap();
        assert!(
            verifier_profile
                .allowlist
                .contains(&INTERACTIVE_INSPECT_CAPABILITY.to_owned())
        );
        assert!(
            !verifier_profile
                .allowlist
                .contains(&INTERACTIVE_PUBLISH_CAPABILITY.to_owned())
        );
    }

    #[tokio::test]
    async fn publish_validates_commits_reconciles_and_verifier_evaluates() {
        let dir = tempdir().unwrap();
        let ws = tempdir().unwrap();
        let bridge: Arc<dyn InteractiveContentBridge> = Arc::new(FakeOpenUiBridge {
            fail_first: AtomicUsize::new(0),
        });
        let owner = InteractiveOwner {
            workspace_id: "ws-ir-pub".to_owned(),
            conversation_id: "conv-bot-pub".to_owned(),
        };
        let worker_ctx = WorkSessionInteractiveContext {
            data_home: dir.path().to_path_buf(),
            owner: owner.clone(),
            plan_id: "plan-pub-1".to_owned(),
            session_id: "sess-pub-1".to_owned(),
            plan_conversation_id: "sess-pub-1".to_owned(),
            execution_epoch: "epoch-pub-1".to_owned(),
            role: "session_worker".to_owned(),
            can_publish: true,
            bridge: Arc::clone(&bridge),
            on_published: None,
        };
        let repair_counter = AtomicUsize::new(0);

        // First call with broken program returns repairable validation diagnostic.
        let bad = run_publish(
            &worker_ctx,
            &json!({
                "publication": { "kind": "create" },
                "title": "Demo",
                "textFallback": "Fallback",
                "program": "BROKEN",
                "inputs": []
            }),
            "call-bad-1",
            "stream-1",
            "worker-conv-1",
            &repair_counter,
            CancellationToken::new(),
        )
        .await;
        assert_eq!(bad.status, "failed");
        assert_eq!(bad.output["publicationStatus"], "not_committed");
        assert_eq!(bad.output["diagnostic"]["code"], "invalid_program");
        assert_eq!(bad.output["diagnostic"]["repair"]["remaining"], 2);

        // Second call succeeds, writes store.sqlite + evidence-index.jsonl with real specHash.
        let ok = run_publish(
            &worker_ctx,
            &json!({
                "publication": { "kind": "create" },
                "title": "项目交付概览",
                "textFallback": "虚构数据：模块 A 正常，模块 B 风险。",
                "program": "$status=\"all\"\nroot=Col([Title(\"项目交付概览\")])",
                "inputs": [{ "bindingId": "rows", "source": { "kind": "model-data", "value": [{"id": "a", "status": "ok"}] } }]
            }),
            "call-ok-1",
            "stream-1",
            "worker-conv-1",
            &repair_counter,
            CancellationToken::new(),
        )
        .await;
        assert_eq!(ok.status, "success");
        assert_eq!(ok.output["publicationStatus"], "published");
        assert!(ok.artifacts.is_empty());
        let artifact_ref = ok.output["artifactRef"].as_str().unwrap().to_owned();
        assert!(artifact_ref.starts_with("interactive-result://ws-ir-pub/conv-bot-pub/"));

        // EvidenceIndex contains the canonical interactive userArtifact record bound to plan-pub-1.
        let rows = EvidenceIndexStore::new(dir.path())
            .find(std::slice::from_ref(&artifact_ref), None)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["planId"], "plan-pub-1");
        assert_eq!(rows[0]["conversationId"], "sess-pub-1");
        assert_eq!(rows[0]["userArtifacts"][0]["kind"], "interactive");
        assert_eq!(
            rows[0]["userArtifacts"][0]["specHash"],
            "sha256:37505cc28779ca4e18facf09edb86db7a01a64d58b0acc22841b168707dc3d24"
        );

        // Verifier provider never manifests publish, and successfully runs `evaluate`.
        let verifier_ctx = WorkSessionInteractiveContext {
            role: "verifier".to_owned(),
            can_publish: false,
            ..worker_ctx
        };
        let mut verifier_provider = WorkSessionInteractiveProvider::new(verifier_ctx.clone());
        let manifests = verifier_provider.manifests();
        assert_eq!(manifests.len(), 1);
        assert_eq!(manifests[0].0, INTERACTIVE_INSPECT_TOOL);
        assert!(
            verifier_provider
                .prepare(INTERACTIVE_PUBLISH_CAPABILITY, json!({}), ws.path(), dir.path())
                .is_err()
        );

        let eval = run_inspect(
            &verifier_ctx,
            &json!({
                "target": { "kind": "result", "reference": ok.output["reference"] },
                "view": "evaluate"
            }),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(eval.status, "success");
        assert_eq!(eval.output["classification"], "host-derived");
        assert!(
            eval.output["text"]
                .as_str()
                .unwrap()
                .contains("Evaluated 项目交付概览")
        );
    }

    #[tokio::test]
    async fn main_bot_direct_publish_projects_publish_only_and_notifies_callback() {
        let dir = tempdir().unwrap();
        let ws = tempdir().unwrap();
        let bridge: Arc<dyn InteractiveContentBridge> = Arc::new(FakeOpenUiBridge {
            fail_first: AtomicUsize::new(0),
        });
        let owner = InteractiveOwner {
            workspace_id: "ws-bot-direct".to_owned(),
            conversation_id: "conv-bot-direct".to_owned(),
        };
        let recorded = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let recorded_cb = Arc::clone(&recorded);
        let ctx = WorkSessionInteractiveContext {
            data_home: dir.path().to_path_buf(),
            owner: owner.clone(),
            plan_id: "bot-reply:turn-1".to_owned(),
            session_id: "bot-reply:turn-1".to_owned(),
            plan_conversation_id: "conv-bot-direct".to_owned(),
            execution_epoch: "bot-turn:turn-1".to_owned(),
            role: "project_agent".to_owned(),
            can_publish: true,
            bridge,
            on_published: Some(Arc::new(move |artifact_ref| {
                recorded_cb.lock().unwrap().push(artifact_ref);
            })),
        };
        let mut provider = WorkSessionInteractiveProvider::new(ctx.clone());
        let manifests = provider.manifests();
        assert_eq!(manifests.len(), 1);
        assert_eq!(manifests[0].0, INTERACTIVE_PUBLISH_TOOL);
        assert!(
            manifests[0].1["modeScopes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_str() == Some("project_agent"))
        );
        assert!(
            provider
                .prepare(INTERACTIVE_INSPECT_CAPABILITY, json!({}), ws.path(), dir.path())
                .is_err()
        );
        let repair_counter = AtomicUsize::new(0);
        let ok = run_publish(
            &ctx,
            &json!({
                "publication": { "kind": "create" },
                "title": "主 Bot 交互卡片",
                "textFallback": "主 Bot 直接生成的交互卡片摘要。",
                "program": "$status=\"all\"\nroot=Col([Title(\"主 Bot 交互卡片\")])",
                "inputs": [{ "bindingId": "rows", "source": { "kind": "model-data", "value": [{"id": "a"}] } }]
            }),
            "tc-bot-direct-1",
            "turn-1",
            "conv-bot-direct",
            &repair_counter,
            CancellationToken::new(),
        )
        .await;
        assert_eq!(ok.status, "success");
        assert_eq!(ok.output["publicationStatus"], "published");
        let artifact_ref = ok.output["artifactRef"].as_str().unwrap().to_owned();
        assert_eq!(
            recorded.lock().unwrap().as_slice(),
            std::slice::from_ref(&artifact_ref)
        );
        let rows = EvidenceIndexStore::new(dir.path())
            .find(&[artifact_ref], None)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["planId"], "bot-reply:turn-1");
        assert_eq!(rows[0]["conversationId"], "conv-bot-direct");
    }
}
