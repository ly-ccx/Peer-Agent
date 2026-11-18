//! ACP v1 stdio is a presentation and control adapter for ordinary runs.
mod permission;
mod stdio;

use peer_protocol::{CliExit, JsonLimits, LocalAccessLevel, decode_json_bounded};
use peer_runtime::{
    CancellationToken,
    conversation_host::{ConversationAccess, ConversationOptions, NativeConversationRuntime},
    model_catalog::{
        ContextSelection, ExecSelection, SessionModelMetadata, resolve_exact_session_model,
        resolve_exec, session_models,
    },
    providers::RuntimeMode,
};
use peer_store::ConversationModelSelection;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
    rc::Rc,
};
use tokio::task::{JoinSet, LocalSet};

use self::permission::{ApprovalPort, OutputPort};

const MAX_SESSIONS: usize = 64;
const MAX_ACTIVE: usize = 8;
const MAX_PROMPT: usize = 1024 * 1024;
type SessionMap = RefCell<BTreeMap<String, Session>>;
type Pending = RefCell<BTreeMap<String, tokio::sync::oneshot::Sender<Value>>>;

struct Session {
    workspace: PathBuf,
    model: ExecSelection,
    context: Option<ContextSelection>,
    conversation: Rc<RefCell<Option<String>>>,
    active: Option<CancellationToken>,
}
struct Connection {
    writer: stdio::Writer<io::Stdout>,
    shutdown: CancellationToken,
    pending: Pending,
    next_approval: Cell<u64>,
    home: PathBuf,
    chinese: bool,
    runtime: NativeConversationRuntime,
    sessions: SessionMap,
}

struct Fault(i32, &'static str);
impl Fault {
    const INVALID: Self = Self(-32600, "Invalid request");
    const PARAMS: Self = Self(-32602, "Invalid params");
    const NO_METHOD: Self = Self(-32601, "Method not found");
    const INTERNAL: Self = Self(-32603, "Peer runtime failed");
    const AUTH: Self = Self(-32000, "Configure a Peer model");
    fn reply(self, id: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"error":{"code":self.0,"message":self.1}})
    }
}

pub fn run() -> io::Result<CliExit> {
    let home =
        peer_protocol::data_home().ok_or_else(|| io::Error::other("data home unavailable"))?;
    crate::cancellation::run(|cancel| async move {
        LocalSet::new()
            .run_until(async move {
                let connection = Rc::new(Connection {
                    writer: stdio::Writer::new(io::stdout(), &cancel)?,
                    shutdown: cancel.clone(),
                    pending: RefCell::default(),
                    next_approval: Cell::new(0),
                    runtime: NativeConversationRuntime::new(
                        &home,
                        ConversationAccess::new(LocalAccessLevel::AskBeforeLocal),
                    ),
                    chinese: peer_runtime::system_context::instructions::presentation_locale(
                        &home, &cancel,
                    ) == "zh-CN",
                    home,
                    sessions: RefCell::default(),
                });
                let mut reader = stdio::Reader::new(io::stdin())?;
                let mut tasks = JoinSet::new();
                let mut initialized = false;
                let exit = loop {
                    let frame = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => break Ok(CliExit::Cancelled),
                        done = tasks.join_next(), if !tasks.is_empty() => {
                            if let Some(Err(error)) = done {
                                break Err(io::Error::other(error));
                            }
                            continue;
                        }
                        frame = reader.next_frame(&cancel) => match frame {
                            Ok(Some(frame)) => frame,
                            Ok(None) => break Ok(CliExit::Ok),
                            Err(error) => break Err(error),
                        }
                    };
                    if let Err(error) = connection.route(frame, &mut initialized, &mut tasks).await
                    {
                        break Err(error);
                    }
                };
                cancel.cancel();
                connection.pending.borrow_mut().clear();
                // Cancellation owns the shutdown. Join each Host so that
                // subprocess cleanup and canonical settlement finish before exit.
                while tasks.join_next().await.is_some() {}
                exit
            })
            .await
    })?
}

impl Connection {
    async fn route(
        self: &Rc<Self>,
        frame: Vec<u8>,
        initialized: &mut bool,
        tasks: &mut JoinSet<()>,
    ) -> io::Result<()> {
        if frame.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        let message = match decode_json_bounded(
            &frame,
            JsonLimits {
                bytes: 2 * 1024 * 1024,
                nodes: 16384,
                depth: 32,
                string_bytes: MAX_PROMPT,
            },
        ) {
            Ok(document) => document.value,
            Err(_) => {
                return self
                    .writer
                    .send(&Fault(-32700, "Parse error").reply(Value::Null))
                    .await;
            }
        };
        if message["jsonrpc"] != "2.0" {
            return self.writer.send(&Fault::INVALID.reply(Value::Null)).await;
        }
        let method = message["method"].as_str();
        if method.is_none() && message.get("method").is_none() {
            if (message.get("result").is_some() ^ message.get("error").is_some())
                && let Some(id) = message["id"].as_str()
            {
                if let Some(waiter) = self.pending.borrow_mut().remove(id) {
                    let _ = waiter.send(message);
                }
                return Ok(());
            }
            return self.writer.send(&Fault::INVALID.reply(Value::Null)).await;
        }
        let Some(method) = method else {
            return self.writer.send(&Fault::INVALID.reply(Value::Null)).await;
        };
        let params = &message["params"];
        let Some(id) = message.get("id").cloned() else {
            if method == "session/cancel" && *initialized {
                self.cancel(&params["sessionId"]);
            }
            return Ok(());
        };
        if !(id.is_string() || id.is_i64() || id.is_u64() || id.is_null()) {
            return self.writer.send(&Fault::INVALID.reply(Value::Null)).await;
        }
        let result = match method {
            "initialize" if *initialized => Err(Fault::INVALID),
            "initialize" if params["protocolVersion"] != 1 => Err(Fault::PARAMS),
            "initialize" => {
                *initialized = true;
                Ok(
                    json!({"protocolVersion":1,"agentInfo":{"name":"peer","version":crate::VERSION.trim()},
                    "agentCapabilities":{"loadSession":false,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false}},
                    "authMethods":[]}),
                )
            }
            "session/new" | "session/prompt" | "session/set_config_option" if !*initialized => {
                Err(Fault::INVALID)
            }
            "session/new" => self.new_session(params),
            "session/set_config_option" => self.set_config(params),
            "session/prompt" => match self.start_prompt(params, &id, tasks) {
                Ok(()) => return Ok(()),
                Err(error) => Err(error),
            },
            _ => Err(Fault::NO_METHOD),
        };
        self.reply(id, result).await
    }

    async fn reply(&self, id: Value, result: Result<Value, Fault>) -> io::Result<()> {
        let message = match result {
            Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
            Err(error) => error.reply(id),
        };
        self.writer.send(&message).await
    }

    fn new_session(&self, params: &Value) -> Result<Value, Fault> {
        if params["mcpServers"]
            .as_array()
            .is_none_or(|servers| !servers.is_empty())
        {
            return Err(Fault::PARAMS);
        }
        let workspace = params["cwd"]
            .as_str()
            .map(Path::new)
            .filter(|p| p.is_absolute())
            .ok_or(Fault::PARAMS)?;
        let workspace = std::fs::canonicalize(workspace).map_err(|_| Fault::PARAMS)?;
        if !workspace.is_dir() || workspace.to_str().is_none() {
            return Err(Fault::PARAMS);
        }
        let mut sessions = self.sessions.borrow_mut();
        if sessions.len() >= MAX_SESSIONS {
            return Err(Fault(-32603, "Session limit reached"));
        }
        let model = resolve_exec(&self.home, None, None, None, false).map_err(|_| Fault::AUTH)?;
        let catalog = session_models(&self.home).map_err(|_| Fault::AUTH)?;
        let context = default_context(entry(&catalog, &model)?, None);
        let config = config_options(&catalog, &model, context.as_ref(), self.chinese)?;
        let id = format!("peer-session-{}", sessions.len() + 1);
        sessions.insert(
            id.clone(),
            Session {
                workspace,
                model,
                context,
                conversation: Rc::default(),
                active: None,
            },
        );
        Ok(json!({"sessionId":id,"configOptions":config}))
    }

    fn cancel(&self, session: &Value) {
        let sessions = self.sessions.borrow();
        if let Some(token) = session
            .as_str()
            .and_then(|id| sessions.get(id))
            .and_then(|s| s.active.as_ref())
        {
            token.cancel();
        }
    }

    fn set_config(&self, params: &Value) -> Result<Value, Fault> {
        let id = params["sessionId"].as_str().ok_or(Fault::PARAMS)?;
        let value = params["value"].as_str().ok_or(Fault::PARAMS)?;
        let mut sessions = self.sessions.borrow_mut();
        let session = sessions.get_mut(id).ok_or(Fault::PARAMS)?;
        if session.active.is_some() {
            return Err(Fault(-32600, "Session has an active prompt"));
        }
        let catalog = session_models(&self.home).map_err(|_| Fault::AUTH)?;
        let previous = &session.model;
        let previous_context = session.context.as_ref();
        let replacement_context;
        let replacement = match params["configId"].as_str() {
            Some("model") => {
                let (provider, id): (String, String) =
                    serde_json::from_str(value).map_err(|_| Fault::PARAMS)?;
                let default = resolve_exact_session_model(&self.home, &provider, &id, None)
                    .map_err(|_| Fault::PARAMS)?;
                let prior = previous.selection["reasoningEffort"]
                    .as_str()
                    .filter(|effort| {
                        default
                            .entry
                            .supported_reasoning_efforts
                            .iter()
                            .any(|v| v == *effort)
                    });
                let replacement = if let Some(effort) = prior {
                    resolve_exact_session_model(&self.home, &provider, &id, Some(effort))
                        .map_err(|_| Fault::PARAMS)?
                } else {
                    default
                };
                replacement_context =
                    default_context(entry(&catalog, &replacement)?, previous_context);
                Some(replacement)
            }
            Some("reasoning_effort") if entry(&catalog, previous)?.reasoning => {
                replacement_context = previous_context.cloned();
                Some(
                    resolve_exact_session_model(
                        &self.home,
                        &previous.entry.provider_id,
                        &previous.entry.model_id,
                        Some(value),
                    )
                    .map_err(|_| Fault::PARAMS)?,
                )
            }
            Some("context_window") => {
                let definition = entry(&catalog, previous)?
                    .context
                    .as_ref()
                    .ok_or(Fault::PARAMS)?;
                let choice = definition
                    .choices
                    .iter()
                    .find(|choice| choice.wire_value == value)
                    .ok_or(Fault::PARAMS)?;
                replacement_context = Some(ContextSelection {
                    option_id: definition.id.clone(),
                    value: choice.value.clone(),
                });
                None
            }
            _ => return Err(Fault::PARAMS),
        };
        let options = config_options(
            &catalog,
            replacement.as_ref().unwrap_or(previous),
            replacement_context.as_ref(),
            self.chinese,
        )?;
        if let Some(model) = replacement {
            if let Some(conversation) = session.conversation.borrow().as_deref() {
                self.runtime
                    .update_chat_model(
                        conversation,
                        &session.workspace,
                        &ConversationModelSelection {
                            provider_id: &model.entry.provider_id,
                            model: &model.entry.model_id,
                            effort: model.selection["reasoningEffort"]
                                .as_str()
                                .unwrap_or("default"),
                        },
                    )
                    .map_err(|error| {
                        eprintln!("peer acp: {}", error.0);
                        Fault::INTERNAL
                    })?;
            }
            session.model = model;
        }
        session.context = replacement_context;
        Ok(json!({"configOptions":options}))
    }
    fn start_prompt(
        self: &Rc<Self>,
        params: &Value,
        request: &Value,
        tasks: &mut JoinSet<()>,
    ) -> Result<(), Fault> {
        let id = params["sessionId"]
            .as_str()
            .ok_or(Fault::PARAMS)?
            .to_owned();
        let blocks = params["prompt"]
            .as_array()
            .filter(|blocks| !blocks.is_empty())
            .ok_or(Fault::PARAMS)?;
        let mut prompt = String::new();
        for (index, block) in blocks.iter().enumerate() {
            if block["type"] != "text" {
                return Err(Fault::PARAMS);
            }
            let text = block["text"].as_str().ok_or(Fault::PARAMS)?;
            if prompt.len() + text.len() + usize::from(index != 0) > MAX_PROMPT {
                return Err(Fault::PARAMS);
            }
            if index != 0 {
                prompt.push('\n');
            }
            prompt.push_str(text);
        }
        if peer_protocol::javascript_trim(&prompt).is_empty() {
            return Err(Fault::PARAMS);
        }
        let mut sessions = self.sessions.borrow_mut();
        if sessions.values().filter(|s| s.active.is_some()).count() >= MAX_ACTIVE {
            return Err(Fault(-32603, "Prompt limit reached"));
        }
        let session = sessions.get_mut(&id).ok_or(Fault::PARAMS)?;
        if session.active.is_some() {
            return Err(Fault(-32600, "Session has an active prompt"));
        }
        let cancel = self.shutdown.child_token();
        session.active = Some(cancel.clone());
        let workspace = session.workspace.clone();
        let selection = session.model.selection.clone();
        let context = session.context.clone();
        let provider = session.model.entry.provider_id.clone();
        let conversation = session.conversation.clone();
        let request = request.clone();
        let connection = self.clone();
        tasks.spawn_local(async move {
            let outcome = async {
                let model = peer_runtime::model_config::load_session_model(
                    &connection.home,
                    &selection,
                    context.as_ref(),
                    &cancel,
                )
                .await
                .map_err(|_| Fault::AUTH)?;
                let existing = conversation.borrow().clone();
                let mut approval = ApprovalPort::new(connection.clone(), id.clone());
                let mut output =
                    OutputPort::new(connection.clone(), id.clone(), conversation.clone());
                let result = connection
                    .runtime
                    .execute_observed(
                        &ConversationOptions {
                            workspace: &workspace,
                            conversation_id: existing.as_deref(),
                            prompt: &prompt,
                            provider_id: &provider,
                            mode: RuntimeMode::Chat,
                            effort: selection["reasoningEffort"].as_str().unwrap_or("default"),
                            persist_model_selection: true,
                            allowlist: None,
                            max_turns: None,
                        },
                        &model,
                        &mut approval,
                        Some(&mut output),
                        &cancel,
                    )
                    .await
                    .map_err(|error| {
                        if !cancel.is_cancelled() {
                            eprintln!("peer acp: {}", error.0);
                        }
                        Fault::INTERNAL
                    })?;
                conversation.replace(Some(result.session_id));
                if let Some(error) = result.error {
                    if !cancel.is_cancelled() {
                        eprintln!("peer acp: {error}");
                    }
                    return Err(Fault::INTERNAL);
                }
                Ok(json!({"stopReason":"end_turn"}))
            }
            .await;
            let outcome = if cancel.is_cancelled() {
                Ok(json!({"stopReason":"cancelled"}))
            } else {
                outcome
            };
            if let Some(session) = connection.sessions.borrow_mut().get_mut(&id) {
                session.active = None;
            }
            if !connection.shutdown.is_cancelled() {
                let _ = connection.reply(request, outcome).await;
            }
        });
        Ok(())
    }
}

fn entry<'a>(
    catalog: &'a [SessionModelMetadata],
    selection: &ExecSelection,
) -> Result<&'a SessionModelMetadata, Fault> {
    catalog
        .iter()
        .find(|option| {
            option.provider_id == selection.entry.provider_id
                && option.model_id == selection.entry.model_id
        })
        .ok_or(Fault::PARAMS)
}

fn default_context(
    option: &SessionModelMetadata,
    prior: Option<&ContextSelection>,
) -> Option<ContextSelection> {
    let definition = option.context.as_ref()?;
    let selected = prior
        .and_then(|selection| definition.choice(&selection.value))
        .map(|choice| &choice.value)
        .or(definition.default.as_ref())?;
    Some(ContextSelection {
        option_id: definition.id.clone(),
        value: selected.clone(),
    })
}

fn config_options(
    catalog: &[SessionModelMetadata],
    selection: &ExecSelection,
    context: Option<&ContextSelection>,
    chinese: bool,
) -> Result<Vec<Value>, Fault> {
    let identity =
        |option: &SessionModelMetadata| json!([option.provider_id, option.model_id]).to_string();
    let selected = entry(catalog, selection)?;
    let mut groups: Vec<(&str, &str, Vec<Value>)> = Vec::new();
    for option in catalog {
        let row = json!({"value":identity(option),"name":option.model_label});
        if let Some(group) = groups
            .iter_mut()
            .find(|(id, _, _)| *id == option.provider_id)
        {
            group.2.push(row);
        } else {
            groups.push((&option.provider_id, &option.group_label, vec![row]));
        }
    }
    let groups: Vec<_> = groups
        .into_iter()
        .map(|(id, label, choices)| json!({"group":id,"name":label,"options":choices}))
        .collect();
    let mut config = vec![
        json!({"id":"model","category":"model","name":"Model","type":"select",
        "currentValue":identity(selected),"options":groups}),
    ];
    if selected.reasoning {
        let options: Vec<_> = selection
            .entry
            .supported_reasoning_efforts
            .iter()
            .map(|effort| json!({"value":effort,"name":effort}))
            .collect();
        config.push(json!({"id":"reasoning_effort","category":"thought_level","name":if chinese { "推理强度" } else { "Reasoning effort" },
            "type":"select","currentValue":selection.selection["reasoningEffort"],"options":options}));
    }
    if let (Some(definition), Some(context)) = (&selected.context, context) {
        let choice = definition
            .choice(&context.value)
            .filter(|_| context.option_id == definition.id)
            .ok_or(Fault::PARAMS)?;
        let options: Vec<_> = definition
            .choices
            .iter()
            .map(|choice| json!({"value":choice.wire_value,"name":choice.label}))
            .collect();
        config.push(
            json!({"id":"context_window","name":if chinese { "上下文窗口" } else { "Context window" },"type":"select",
            "currentValue":choice.wire_value,"options":options}),
        );
    }
    Ok(config)
}
