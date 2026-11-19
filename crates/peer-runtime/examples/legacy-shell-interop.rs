//! Development probe that resumes an isolated legacy conversation through the native Host.
#![forbid(unsafe_code)]
use peer_protocol::LocalAccessLevel;
use peer_runtime::{
    CancellationToken,
    conversation_host::{ConversationAccess, ConversationOptions, NativeConversationRuntime},
    model_catalog::resolve_exec,
    model_config::load_model,
    providers::RuntimeMode,
    session_host::{LocalPermissionDecision, PermissionInput},
};
use serde_json::{Value, json};
use std::{future::Future, io, pin::Pin};

struct RejectPermission;
impl PermissionInput for RejectPermission {
    fn decide<'a>(
        &'a mut self,
        _prompt: Value,
        _cancel: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = LocalPermissionDecision> + 'a>> {
        Box::pin(async { LocalPermissionDecision::Deny })
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    let home = peer_protocol::data_home().ok_or_else(|| io::Error::other("data home"))?;
    if !home.join(".native-cli-fixture").is_file() {
        return Err(io::Error::other("isolated fixture required"));
    }
    let id = std::env::args()
        .nth(1)
        .ok_or_else(|| io::Error::other("session missing"))?;
    let cancel = CancellationToken::new();
    let selected = resolve_exec(&home, None, None, None, false)
        .map_err(|error| io::Error::other(error.detail))?;
    let model = load_model(&home, &selected.selection, &cancel)
        .await
        .map_err(|error| io::Error::other(error.code))?;
    let workspace = std::env::current_dir()?;
    let runtime = NativeConversationRuntime::new(
        &home,
        ConversationAccess::new(LocalAccessLevel::AskBeforeLocal),
    );
    let outcome = runtime
        .execute(
            &ConversationOptions {
                workspace: &workspace,
                conversation_id: Some(&id),
                resume_from: None,
                prompt: "Continue in the existing conversation from Rust.",
                image_paths: &[],
                provider_id: &selected.entry.provider_id,
                mode: RuntimeMode::Chat,
                effort: "default",
                persist_model_selection: false,
                allowlist: Some(&[]),
                max_turns: Some(1),
            },
            &model,
            &mut RejectPermission,
            &cancel,
        )
        .await
        .map_err(|error| io::Error::other(error.0))?;
    println!(
        "{}",
        json!({"id":outcome.session_id,"error":outcome.error,"content":outcome.content})
    );
    Ok(())
}
