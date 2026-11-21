use peer_protocol::{CliExit, ModelMetadataState};
use serde_json::{Value, json};
use std::io::{self, Write};
fn receipt(action: &str, channel: &str, metadata: ModelMetadataState) -> Value {
    let mut value = json!({"status":match action {
        "logout"=>"credential_removed",
        "reconcile" if metadata==ModelMetadataState::Synced=>"metadata_reconciled",
        "reconcile"=>"metadata_reconcile_pending",
        _=>"credential_updated"
    },"channelId":channel,"metadataStatus":metadata});
    if metadata != ModelMetadataState::Synced {
        value["nextAction"] = json!(format!("peer-native models reconcile {channel}"));
    }
    value
}
pub fn run(action: &str, channel: &str) -> io::Result<CliExit> {
    let home =
        peer_protocol::data_home().ok_or_else(|| io::Error::other("data home unavailable"))?;
    let (result, cancelled) = crate::cancellation::run(|cancel| async move {
        let result = match action {
            "status" => peer_runtime::model_auth::status(&home, channel, &cancel)
                .await
                .map(|status| serde_json::to_value(status).unwrap()),
            "logout" => peer_runtime::model_auth::logout(&home, channel, &cancel)
                .await
                .map(|metadata| receipt(action, channel, metadata)),
            "reconcile" => peer_runtime::model_auth::reconcile(&home, channel, &cancel)
                .await
                .map(|metadata| receipt(action, channel, metadata)),
            _ => peer_runtime::model_auth::authorize(&home, channel, &cancel, |prompt| {
                let mut value = serde_json::to_value(prompt).unwrap();
                value["status"] = json!("authorization_required");
                value["channelId"] = json!(channel);
                value["nextAction"] = json!(if prompt.user_code.is_some() {
                    "Open authorizationUrl and enter userCode. Ctrl-C cancels this login."
                } else {
                    "Open the URL in your browser. Ctrl-C cancels this login."
                });
                writeln!(io::stdout(), "{value}")
                    .map_err(|_| peer_runtime::model::ModelError::new("model_oauth_output_failed"))
            })
            .await
            .map(|metadata| receipt(action, channel, metadata)),
        };
        (result, cancel.is_cancelled())
    })?;
    match result {
        Ok(value) => {
            writeln!(io::stdout(), "{value}")?;
            Ok(if cancelled {
                CliExit::Cancelled
            } else if value["status"] == "metadata_reconcile_pending" {
                CliExit::Runtime
            } else {
                CliExit::Ok
            })
        }
        Err(error) => {
            writeln!(
                io::stderr(),
                "peer-native: {}; inspect credential state with models status",
                error.code
            )?;
            Ok(if cancelled || error.code == "CANCELLED" {
                CliExit::Cancelled
            } else {
                CliExit::Auth
            })
        }
    }
}
