//! Isolated development Host seam, never loaded/spawned by the native CLI.
use peer_protocol::CoordinationReducer;
use peer_runtime::coordination::NativeCoordinationReducer;
use peer_store::{AcquireLease, CoordinationStore, HostIdentity, HostLeaseStore, HostSurface};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    io::{self, Read},
    path::PathBuf,
};
struct FaultKernel<'a> {
    root: &'a std::path::Path,
    mode: &'a str,
    done: AtomicBool,
    cancel: &'a AtomicBool,
}
impl CoordinationReducer for FaultKernel<'_> {
    fn reduce(&self, state: &Value, entry: &Value) -> Result<Value, &'static str> {
        let result = NativeCoordinationReducer.reduce(state, entry)?;
        let should = self.mode != "blob"
            || entry["work"]["opaque"]
                .as_str()
                .is_some_and(|s| s.len() > 60000);
        if should && !self.done.swap(true, Ordering::AcqRel) {
            match self.mode {
                "cancel" => self.cancel.store(true, Ordering::Release),
                "head" | "lease" => {
                    let file = self.root.join(if self.mode == "head" {
                        "project-runtime/w/coordination-v2/head.json"
                    } else {
                        "project-runtime/w/host.lease"
                    });
                    let mut value: Value =
                        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
                    if self.mode == "head" {
                        value["racer"] = json!(true)
                    } else {
                        value["hostId"] = json!("replacement-host")
                    }
                    std::fs::write(file, serde_json::to_vec(&value).unwrap()).unwrap();
                }
                "blob" => {
                    let dir = self.root.join("project-runtime/w/coordination-v2/blobs");
                    let first = std::fs::read_dir(dir)
                        .unwrap()
                        .next()
                        .unwrap()
                        .unwrap()
                        .path();
                    std::fs::write(first, b"{}").unwrap();
                }
                _ => (),
            }
        }
        Ok(result)
    }
}
fn main() {
    let root =
        PathBuf::from(std::env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").expect("fixture root"));
    assert!(root.join(".native-cli-fixture").is_file());
    let mut input = Vec::new();
    io::stdin().take(1_048_577).read_to_end(&mut input).unwrap();
    assert!(input.len() <= 1_048_576);
    let v = peer_protocol::decode_json_bounded(
        &input,
        peer_protocol::JsonLimits {
            bytes: 1_048_576,
            nodes: 32_768,
            depth: 64,
            string_bytes: 1_048_576,
        },
    )
    .unwrap()
    .value;
    let host = HostIdentity::new(
        "native-canonical",
        HostSurface::Tui,
        std::process::id(),
        "fixture",
    )
    .unwrap();
    let lease = match HostLeaseStore::new(&root)
        .acquire("w", &host, v["now"].as_i64().unwrap_or(1_000_000))
        .unwrap()
    {
        AcquireLease::Acquired { token, .. } => token,
        AcquireLease::Held(_) => {
            println!("{}", json!({"ok":false,"code":"fixture_lease_held"}));
            return;
        }
    };
    let mut store = CoordinationStore::new(lease);
    let cancel = AtomicBool::new(v["cancel"] == true);
    let reducer = FaultKernel {
        root: &root,
        mode: v["during"].as_str().unwrap_or(""),
        done: AtomicBool::new(false),
        cancel: &cancel,
    };
    let result = (|| {
        if v["initialize"] == true {
            store.initialize(&NativeCoordinationReducer, None)?;
        }
        if v["recover"] == true {
            store.prepare(&NativeCoordinationReducer, None)?;
        }
        let first = store.read(&reducer, Some(&cancel))?;
        if v["protect"] == true {
            store.prepare(&NativeCoordinationReducer, None)?;
        }
        let mut last = store.read(&reducer, Some(&cancel))?;
        if first.state != last.state {
            return Err(peer_store::CoordinationError::Changed);
        }
        if v["checkpoint"] == true {
            last = store.checkpoint_head(&last, &NativeCoordinationReducer, None)?;
        }
        if let Some(event) = v.get("event") {
            last = if v["interrupt"] == true || v["crash"] == true {
                store.append_fixture(
                    &last,
                    event,
                    2_000_000,
                    &NativeCoordinationReducer,
                    v["crash"] == true,
                )?
            } else {
                store.append(&last, event, 2_000_000, &NativeCoordinationReducer, None)?
            };
        }
        Ok(
            json!({"ok":true,"state":last.state,"hash":last.hash,"headRevision":last.durable_head_revision,"fenced":last.physically_fenced}),
        )
    })();
    let out = match result {
        Ok(v) => v,
        Err(e) => json!({"ok":false,"code":e.code()}),
    };
    let token = store.into_lease();
    if token.holds().unwrap_or(false) {
        token.release().unwrap();
    }
    println!("{out}");
}
