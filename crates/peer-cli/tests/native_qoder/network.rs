//! Both real Qoder dialects use the existing native TLS/proxy seam.
use super::*;
use crate::native_network::{
    clean_network,
    tls::{CA, ConnectProxy, TlsFront},
};
#[test]
fn both_qoder_dialects_keep_tls_proxy_trust_and_tool_evidence_boundaries() {
    for legacy in [false, true] {
        for wrong_name in [false, true] {
            let server = Server::new(vec![
                reply_tool("read_file", json!({"path":"input.txt"})),
                reply_text("TLS Qoder complete."),
            ]);
            let tls = TlsFront::new(&server, wrong_name);
            let proxy = ConnectProxy::new(tls.address);
            let f = Fixture::new(&server);
            configure(&f, &server);
            if legacy {
                super::legacy::select(&f, "unknown-model");
            }
            let mut config = get(f.root.path().join("llm-providers.json"));
            config["channels"][0]["baseUrl"] = json!(tls.url);
            put(f.root.path().join("llm-providers.json"), &config);
            put(
                f.root.path().join(".qoder/.cache/endpoint-cache.json"),
                &json!({"entries":{"prod":{"endpoint":tls.url.trim_end_matches("/v1")}}}),
            );
            let ca = f.root.path().join("qoder-ca.pem");
            std::fs::write(&ca, CA).unwrap();
            let original = f.history();
            let mut c = command(&f);
            clean_network(&mut c);
            c.env("HTTPS_PROXY", &proxy.url)
                .env("NO_PROXY", "")
                .env("PEER_EXTRA_CA_CERTS", &ca);
            let output = c.output().unwrap();
            if wrong_name {
                assert!(!output.status.success());
                assert!(server.requests.lock().unwrap().is_empty());
                assert_eq!(f.history(), original);
            } else {
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert_eq!(server.requests.lock().unwrap().len(), 2);
                let history = f.history();
                let tool = history.iter().find(|v| v["segments"].is_array()).unwrap();
                assert_eq!(tool["permissionGrants"][0]["granted"], true);
                assert!(tool["segments"][0]["result"]["evidence"].is_object());
            }
            let connects = proxy.headers.lock().unwrap();
            assert!(!connects.is_empty());
            for header in &*connects {
                let lower = header.to_lowercase();
                assert!(lower.contains("proxy-authorization: basic"));
                assert!(!lower.contains("cosy-key:"));
                assert!(!lower.contains("authorization: bearer"));
            }
            assert!(
                server
                    .request_headers
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|h| !h.to_lowercase().contains("proxy-authorization"))
            );
            assert!(
                !format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                )
                .contains("synthetic-proxy-secret")
            );
        }
    }
}
#[test]
fn cancelled_qoder_streams_close_without_exposing_partial_tools_and_admit_a_later_task() {
    for legacy in [false, true] {
        let raw = reply_tool(
            "write_file",
            json!({"path":"partial-qoder.txt","content":"never"}),
        );
        let partial = raw.split("data: [DONE]").next().unwrap().to_owned();
        let server = Server::respond(vec![partial], true);
        let f = Fixture::new(&server);
        configure(&f, &server);
        if legacy {
            super::legacy::select(&f, "unknown-model");
        }
        let original = f.history();
        let mut child = OwnedChild(Some(command(&f).spawn().unwrap()));
        let deadline = Instant::now() + Duration::from_secs(10);
        while server.requests.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        rustix::process::kill_process(
            rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
            rustix::process::Signal::TERM,
        )
        .unwrap();
        while child.child().try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "Qoder cancellation did not settle"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let output = child.output();
        assert_eq!(
            output.status.code(),
            Some(4),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!f.root.path().join("workspace/partial-qoder.txt").exists());
        assert_eq!(f.history(), original);
        while !server.closed.load(std::sync::atomic::Ordering::Acquire) {
            assert!(
                Instant::now() < deadline,
                "cancelled Qoder socket remained open"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(ledger_rows(&f).len(), 1);
        assert_eq!(ledger_rows(&f)[0]["providerRequestCount"], 1);
        f.seed("later", "later-c", "later-s", "later-work", "later-epoch");
        let mut goal = get(f.root.path().join("goal-plans/later.json"));
        for role in ["worker", "explorer", "verifier"] {
            goal["delegationOrigin"]["modelSelection"][role]["modelId"] =
                json!(if legacy { "unknown-model" } else { "auto" });
            goal["delegationOrigin"]["modelSelection"][role]["family"] = json!("qoder");
        }
        put(f.root.path().join("goal-plans/later.json"), &goal);
        let output = command_plan(&f, "later").output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(f.history(), original);
    }
}
