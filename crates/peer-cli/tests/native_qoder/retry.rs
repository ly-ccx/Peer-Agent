//! Physical attempts through the public CLI; all accounts/services are synthetic.
use super::*;
fn setup(f: &Fixture, s: &Server, old: bool) {
    configure(f, s);
    if old {
        legacy::select(f, "unknown-model");
    }
}
fn failure(event: Value) -> String {
    format!("data: {event}\n\n")
}
fn queue(seconds: f64) -> String {
    failure(
        json!({"code":"10605","message":json!({"isQueued":true,"retryAfterSeconds":seconds,"waitTime":189}).to_string()}),
    )
}
fn known_failure(event: Value) -> String {
    format!(
        "data: {}\n\n{}",
        json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}),
        failure(event)
    )
}
fn receipt(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn stable(mut body: Value, old: bool) -> Value {
    let context = if old {
        &mut body["metadata"]["context"]
    } else {
        &mut body
    };
    for name in [
        "request_id",
        "request_set_id",
        "chat_record_id",
        "session_id",
        "task_id",
        "is_retry",
    ] {
        context.as_object_mut().unwrap().remove(name);
    }
    body
}
#[test]
fn queues_retry_both_dialects_with_fresh_ids_fingerprints_and_one_real_tool_effect() {
    for old in [false, true] {
        let server = Server::new(vec![
            queue(0.001),
            reply_tool(
                "write_file",
                json!({"path":"once.txt","content":"one effect"}),
            ),
            reply_text("complete"),
        ]);
        let f = Fixture::new(&server);
        setup(&f, &server, old);
        let r = receipt(&command(&f).output().unwrap());
        assert_eq!(r["toolCalls"], 1);
        assert_eq!(r["usage"]["providerRequestCount"], 3);
        assert_eq!(r["usage"]["totalTokens"], 32);
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("workspace/once.txt")).unwrap(),
            "one effect"
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            stable(requests[0].clone(), old),
            stable(requests[1].clone(), old)
        );
        let context = |i: usize| {
            if old {
                &requests[i]["metadata"]["context"]
            } else {
                &requests[i]
            }
        };
        for key in ["request_id", "session_id", "task_id"] {
            assert_ne!(context(0)[key], context(1)[key]);
        }
        for i in 0..2 {
            assert!(
                context(i)["task_id"]
                    .as_str()
                    .unwrap()
                    .starts_with("peer-agent:")
            );
        }
        if !old {
            assert_eq!(requests[0]["is_retry"], false);
            assert_eq!(requests[1]["is_retry"], true);
        }
        let bytes = server.request_bytes.lock().unwrap();
        assert_ne!(bytes[0], bytes[1]);
        let budget = f.budget(|_| {});
        assert_eq!(budget["modelRequests"], 3);
        assert_eq!(budget["unknownUsage"], true);
        let tools = f
            .history()
            .into_iter()
            .filter(|v| v["segments"].is_array())
            .collect::<Vec<_>>();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["permissionGrants"][0]["granted"], true);
        assert!(tools[0]["segments"][0]["result"]["evidence"].is_object());
    }
}
#[test]
fn known_failed_attempts_are_billed_before_duplicate_and_transient_recovery() {
    for old in [false, true] {
        let server = Server::new(vec![
            known_failure(json!({"code":"103"})),
            known_failure(
                json!({"type":"error","message":"All backends failed SYNTHETIC-PRIVATE"}),
            ),
            reply_text("recovered"),
        ]);
        let f = Fixture::new(&server);
        setup(&f, &server, old);
        let r = receipt(&command(&f).output().unwrap());
        assert_eq!(r["usage"]["providerRequestCount"], 3);
        assert_eq!(r["usage"]["totalTokens"], 48);
        assert_eq!(r["lastRequestUsage"]["totalTokens"], 16);
        assert_eq!(ledger_rows(&f)[0]["totalTokens"], 48);
        assert_eq!(f.budget(|_| {})["tokens"], 48);
        assert!(!r.to_string().contains("SYNTHETIC-PRIVATE"));
        assert!(
            f.history()
                .iter()
                .all(|v| !v.to_string().contains("SYNTHETIC-PRIVATE"))
        );
    }
}
#[test]
fn duplicate_and_transient_limits_are_finite_and_http_auth_does_not_retry() {
    for (reply, count, error) in [
        (failure(json!({"code":103})), 2, "qoder_duplicate_request"),
        (
            "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .into(),
            4,
            "model_http_rejected",
        ),
        (
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            1,
            "model_http_rejected",
        ),
    ] {
        let server = Server::new(vec![reply; count]);
        let f = Fixture::new(&server);
        setup(&f, &server, false);
        let output = command(&f).output().unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(error),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(server.requests.lock().unwrap().len(), count);
        assert_eq!(f.budget(|_| {})["modelRequests"], count);
    }
}
#[test]
fn connection_close_before_headers_recovers_with_a_new_request_identity() {
    for old in [false, true] {
        let server = Server::new(vec![
            "FIXTURE_CLOSE_WITHOUT_HEADERS".into(),
            reply_text("connected"),
        ]);
        let f = Fixture::new(&server);
        setup(&f, &server, old);
        let r = receipt(&command(&f).output().unwrap());
        assert_eq!(r["usage"]["providerRequestCount"], 2);
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            stable(requests[0].clone(), old),
            stable(requests[1].clone(), old)
        );
        let bytes = server.request_bytes.lock().unwrap();
        assert_ne!(bytes[0], bytes[1]);
    }
}
#[test]
fn every_retry_respects_request_and_unknown_token_budget_without_a_second_post() {
    for limits in [
        json!({"maxModelRequests":1}),
        json!({"maxTokens":100}),
        json!({"maxCostUsd":1}),
    ] {
        let server = Server::new(vec![queue(0.001)]);
        let f = Fixture::new(&server);
        setup(&f, &server, false);
        f.budget(|b| b["limits"] = limits);
        let output = command(&f).output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("work_budget_limited"));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert_eq!(f.budget(|_| {})["unknownUsage"], true);
    }
}
fn wait_attempt(server: &Server, child: &mut OwnedChild) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while server.requests.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline);
        assert!(child.child().try_wait().unwrap().is_none());
        thread::sleep(Duration::from_millis(10));
    }
    // The response is complete and the Host should now be in the policy wait.
    thread::sleep(Duration::from_millis(150));
    assert!(child.child().try_wait().unwrap().is_none());
}
#[test]
fn waiting_revalidates_credentials_and_history_and_preserves_known_fees() {
    for history in [false, true] {
        let server = Server::new(vec![known_failure(
            json!({"code":10605,"message":{"retryAfterSeconds":0.8}}),
        )]);
        let f = Fixture::new(&server);
        setup(&f, &server, false);
        let mut child = OwnedChild(Some(command(&f).spawn().unwrap()));
        wait_attempt(&server, &mut child);
        if history {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(f.root.path().join("conversations/c.jsonl"))
                .unwrap();
            writeln!(file,"{}",json!({"id":"concurrent","role":"user","content":"new factual source","createdAt":AT})).unwrap();
        } else {
            std::fs::write(f.root.path().join(".qoder/.auth/user"), "external logout").unwrap();
        }
        let output = child.output();
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(if history {
                "CONTEXT_SNAPSHOT_CHANGED"
            } else {
                "qoder_auth_changed"
            }),
            "{stderr}"
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert_eq!(ledger_rows(&f)[0]["totalTokens"], 16);
        assert_eq!(f.budget(|_| {})["tokens"], 16);
    }
}
#[test]
fn long_queue_wait_renews_lease_cancels_promptly_and_admits_later_work() {
    let server = Server::new(vec![
        known_failure(json!({"code":10605,"message":{"retryAfterSeconds":60}})),
        reply_text("later"),
    ]);
    let f = Fixture::new(&server);
    setup(&f, &server, false);
    let mut child = OwnedChild(Some(command(&f).spawn().unwrap()));
    wait_attempt(&server, &mut child);
    let lease = f.root.path().join("project-runtime/w/host.lease");
    let before = get(&lease)["heartbeatAt"].clone();
    let deadline = Instant::now() + Duration::from_secs(8);
    while get(&lease)["heartbeatAt"] == before {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(50));
    }
    let start = Instant::now();
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = child.output();
    assert_eq!(output.status.code(), Some(4));
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(ledger_rows(&f)[0]["totalTokens"], 16);
    f.seed("later", "later-c", "later-s", "later-work", "later-epoch");
    let mut goal = get(f.root.path().join("goal-plans/later.json"));
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role]["modelId"] = json!("auto");
        goal["delegationOrigin"]["modelSelection"][role]["family"] = json!("qoder");
    }
    put(f.root.path().join("goal-plans/later.json"), &goal);
    let r = receipt(&command_plan(&f, "later").output().unwrap());
    assert_eq!(r["usage"]["providerRequestCount"], 1);
}

#[test]
fn retry_discards_partial_intents_and_keeps_their_observed_usage() {
    let raw = reply_tool(
        "write_file",
        json!({"path":"partial-retry.txt","content":"never"}),
    );
    let partial = raw.split("data: [DONE]").next().unwrap().to_owned();
    let server = Server::new(vec![
        format!(
            "{partial}{}",
            failure(json!({"type":"error","message":"rate limit"}))
        ),
        reply_text("recovered"),
    ]);
    let f = Fixture::new(&server);
    setup(&f, &server, false);
    let r = receipt(&command(&f).output().unwrap());
    assert_eq!(r["toolCalls"], 0);
    assert_eq!(r["usage"]["totalTokens"], 32);
    assert!(!f.root.path().join("workspace/partial-retry.txt").exists());
    assert!(f.history().iter().all(|v| !v["segments"].is_array()));
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        stable(requests[0].clone(), false),
        stable(requests[1].clone(), false)
    );
}
#[test]
fn hard_exit_during_wait_recovers_known_fees_without_resuming_the_old_request() {
    for known in [false, true] {
        let event = json!({"code":10605,"message":{"retryAfterSeconds":60}});
        let server = Server::new(vec![
            if known {
                known_failure(event)
            } else {
                failure(event)
            },
            reply_text("unconsumed"),
        ]);
        let f = Fixture::new(&server);
        setup(&f, &server, false);
        let mut child = OwnedChild(Some(command(&f).spawn().unwrap()));
        wait_attempt(&server, &mut child);
        // The sidecar is published before the index. Wait for the committed
        // pair and released Store locks, so this kill targets the policy wait
        // rather than an in-flight Store transaction (which needs maintenance).
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let committed =
                std::fs::read_to_string(f.root.path().join("conversations/index.jsonl"))
                    .ok()
                    .and_then(|text| {
                        text.lines().find_map(|line| {
                            serde_json::from_str::<Value>(line)
                                .ok()
                                .filter(|v| v["id"] == "c")
                        })
                    });
            if committed.is_some_and(|v| v["contextSnapshot"]["phase"] == "turn_complete")
                && !f
                    .root
                    .path()
                    .join("conversations/index.jsonl.lock")
                    .exists()
                && !f.root.path().join("conversations/c.jsonl.lock").exists()
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "attempt observation did not commit"
            );
            assert!(child.child().try_wait().unwrap().is_none());
            thread::sleep(Duration::from_millis(10));
        }
        child.child().kill().unwrap();
        let output = child.output();
        assert!(!output.status.success());
        f.age_dead_lease();
        let budget = f.budget(|_| {});
        assert_eq!(budget["modelRequests"], 1);
        assert_eq!(budget["tokens"], if known { 16 } else { 0 });
        if !known {
            assert_eq!(budget["unknownUsage"], true);
        }
        let rejected = command(&f).output().unwrap();
        assert!(!rejected.status.success(), "restart must require recovery");
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "restart must not resume queue polling"
        );
        for _ in 0..2 {
            let output = f.command("recover", "p").output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        if known {
            assert_eq!(ledger_rows(&f).len(), 1);
            assert_eq!(ledger_rows(&f)[0]["totalTokens"], 16);
        } else {
            assert!(!f.root.path().join("usage/requests.jsonl").exists());
        }
        let original = f.history();
        f.seed("later", "later-c", "later-s", "later-work", "later-epoch");
        let mut goal = get(f.root.path().join("goal-plans/later.json"));
        for role in ["worker", "explorer", "verifier"] {
            goal["delegationOrigin"]["modelSelection"][role]["modelId"] = json!("auto");
            goal["delegationOrigin"]["modelSelection"][role]["family"] = json!("qoder");
        }
        put(f.root.path().join("goal-plans/later.json"), &goal);
        let r = receipt(&command_plan(&f, "later").output().unwrap());
        assert_eq!(r["usage"]["providerRequestCount"], 1);
        assert_eq!(server.requests.lock().unwrap().len(), 2);
        assert_eq!(f.history(), original);
    }
}

#[test]
fn queue_after_a_committed_shell_effect_does_not_replay_the_tool() {
    for old in [false, true] {
        let server = Server::new(vec![
            reply_tool("bash", json!({"command":"printf x >> once-count.txt"})),
            queue(0.001),
            reply_text("complete"),
        ]);
        let f = Fixture::new(&server);
        setup(&f, &server, old);
        let r = receipt(&command(&f).output().unwrap());
        assert_eq!(r["toolCalls"], 1);
        assert_eq!(r["usage"]["providerRequestCount"], 3);
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("workspace/once-count.txt")).unwrap(),
            "x"
        );
        let history = f.history();
        let tools = history
            .iter()
            .filter(|v| v["segments"].is_array())
            .collect::<Vec<_>>();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["segments"][0]["result"]["status"], "success");
        assert!(tools[0]["segments"][0]["result"]["evidence"].is_object());
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            stable(requests[1].clone(), old),
            stable(requests[2].clone(), old)
        );
    }
}
