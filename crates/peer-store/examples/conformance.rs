//! Isolated development fixture runner. Never shipped or invoked by peer-native.
//! Requires an explicit fixture root and marker; no personal data defaults.
use peer_protocol::LocalAccessLevel;
use peer_store::{ConversationStore, DirectoryLock, PolicyStore, PolicyUpdateError};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    path::PathBuf,
    time::Duration,
};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    History {
        id: String,
    },
    PolicyRead {
        workspace_id: String,
    },
    PolicyUncheckpointedSchema,
    PolicyInitialize {
        legacy_access_level: LocalAccessLevel,
        updated_at: String,
    },
    PolicyRegister {
        workspace_id: String,
        updated_at: String,
    },
    PolicyUpdate {
        workspace_id: String,
        expected_revision: u64,
        access_level: LocalAccessLevel,
        updated_at: String,
    },
    Lock {
        hold_ms: u64,
        timeout_ms: u64,
    },
}

fn run() -> Result<Value, Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").ok_or("fixture root required")?,
    );
    if !root.join(".native-cli-fixture").is_file() {
        return Err("fixture marker required".into());
    }
    let mut input = String::new();
    io::stdin().take(1_048_577).read_to_string(&mut input)?;
    if input.len() > 1_048_576 {
        return Err("request too large".into());
    }
    let request: Request = serde_json::from_str(&input)?;
    Ok(match request {
        Request::PolicyUncheckpointedSchema => {
            // Synthetic WAL recovery fixture: process::exit deliberately skips
            // Rust Drop, like a stopped writer whose committed WAL remains.
            let database =
                rusqlite::Connection::open(root.join("project-runtime/bot-access.sqlite"))?;
            database.pragma_update(None, "user_version", 2)?;
            writeln!(
                io::stdout(),
                "{}",
                json!({"ok":true,"simulatedUncleanExit":true})
            )?;
            io::stdout().flush()?;
            std::process::exit(0);
        }
        Request::PolicyInitialize {
            legacy_access_level,
            updated_at,
        } => match PolicyStore::new(&root).initialize(legacy_access_level, &updated_at, None) {
            Ok(_) => json!({"ok":true}),
            Err(error) => json!({"ok":false,"code":error.code()}),
        },
        Request::PolicyRegister {
            workspace_id,
            updated_at,
        } => match PolicyStore::new(&root).read_or_register(&workspace_id, &updated_at) {
            Ok(policy) => json!({"ok":true,"policy":policy}),
            Err(error) => json!({"ok":false,"code":error.code()}),
        },
        Request::History { id } => {
            match ConversationStore::new(&root).read_committed(&id, None, 8 * 1024 * 1024) {
                Ok(snapshot) => json!({"ok":true,"history":snapshot.history}),
                Err(error) => json!({"ok":false,"code":error.code()}),
            }
        }
        Request::PolicyRead { workspace_id } => {
            match PolicyStore::new(&root).read_existing(&workspace_id) {
                Ok(policy) => json!({"ok":true,"policy":policy}),
                Err(error) => json!({"ok":false,"code":error.code()}),
            }
        }
        Request::PolicyUpdate {
            workspace_id,
            expected_revision,
            access_level,
            updated_at,
        } => {
            match PolicyStore::new(&root).update_existing(
                &workspace_id,
                expected_revision,
                access_level,
                &updated_at,
            ) {
                Ok(policy) => json!({"ok":true,"policy":policy}),
                Err(PolicyUpdateError::Conflict(policy)) => {
                    json!({"ok":false,"code":"POLICY_CONFLICT","policy":policy})
                }
                Err(PolicyUpdateError::Store(error)) => json!({"ok":false,"code":error.code()}),
            }
        }
        Request::Lock {
            hold_ms,
            timeout_ms,
        } => {
            if hold_ms > 1000 || timeout_ms > 1000 {
                return Err("fixture timeout exceeds bound".into());
            }
            match DirectoryLock::acquire(
                &root.join("conversations/index.jsonl"),
                Duration::from_millis(timeout_ms),
                None,
            ) {
                Ok(lock) => {
                    writeln!(io::stdout(), "{}", json!({"phase":"locked"}))?;
                    io::stdout().flush()?;
                    std::thread::sleep(Duration::from_millis(hold_ms));
                    lock.release()?;
                    json!({"ok":true})
                }
                Err(error) => json!({"ok":false,"code":error.code()}),
            }
        }
    })
}

fn main() {
    let result = run().unwrap_or_else(|error| json!({"ok":false,"fixtureError":error.to_string()}));
    println!("{result}");
}
