use super::*;
fn plain(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
fn next(f: &Fixture) {
    seed_next(f);
    let file = f.root.path().join("goal-plans/next.json");
    let mut goal = get(&file);
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role]["modelId"] = json!("grok-4.5");
    }
    put(file, &goal);
}
#[test]
fn compatibility_426_resends_only_once_with_changed_official_feed_and_exact_original_request_bytes()
{
    for mode in [
        "changed",
        "same",
        "second-426",
        "feed-failed",
        "future-major",
    ] {
        let idp = Idp::new(refreshed(), "200 OK", false, false);
        let second = match mode {
            "same" => plain("200 OK", "1.0.77"),
            "feed-failed" => plain("503 Unavailable", "offline"),
            "future-major" => plain("200 OK", "2.0.0"),
            _ => plain("200 OK", "1.0.78"),
        };
        let version = Server::new(vec![plain("200 OK", "1.0.77"), second]);
        let reject = plain("426 Upgrade Required", "update to version 9.9.9");
        let model = Server::new(if mode == "changed" {
            vec![
                reject,
                stream("openai-responses", "tool"),
                stream("openai-responses", "text"),
            ]
        } else if mode == "second-426" {
            vec![reject.clone(), reject]
        } else {
            vec![reject]
        });
        let f = Fixture::new(&model);
        grok_config(&f, &idp.url, &model.url, &version.url, true);
        let output = command(&f, "p").output().unwrap();
        assert_eq!(
            output.status.success(),
            mode == "changed",
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(version.requests.lock().unwrap().len(), 2);
        assert!(
            version
                .request_headers
                .lock()
                .unwrap()
                .iter()
                .all(|h| !h.to_ascii_lowercase().contains("authorization:")
                    && !h.to_ascii_lowercase().contains("x-xai-token-auth:"))
        );
        let bodies = model.request_bytes.lock().unwrap();
        assert_eq!(
            bodies.len(),
            if mode == "changed" {
                3
            } else if mode == "second-426" {
                2
            } else {
                1
            }
        );
        if matches!(mode, "changed" | "second-426") {
            assert_eq!(bodies[0], bodies[1], "same frozen wire bytes");
            let headers = model.request_headers.lock().unwrap();
            assert!(headers[0].contains("x-grok-client-version: 1.0.77"));
            assert!(headers[1].contains("x-grok-client-version: 1.0.78"));
        }
        assert!(idp.requests.lock().unwrap().is_empty());
        if mode != "changed" {
            assert!(f.history().iter().all(|r| !r["segments"].is_array()));
        }
    }
}
#[test]
fn invalid_metadata_and_missing_or_conflicting_grok_grants_fail_before_inference_and_admit_after_repair()
 {
    for mode in [
        "invalid",
        "future",
        "oversized",
        "redirect",
        "no-api",
        "issuer",
        "client",
        "provider",
    ] {
        let idp = Idp::new(refreshed(), "200 OK", false, false);
        let version=Server::new(vec![match mode{"invalid"=>plain("200 OK","not-a-version"),"future"=>plain("200 OK","2.0.0"),"oversized"=>plain("200 OK",&"1".repeat(65)),"redirect"=>"HTTP/1.1 307 Redirect\r\nLocation: http://127.0.0.1:1/must-not-follow\r\nContent-Length: 0\r\n\r\n".into(),_=>plain("200 OK","1.0.77")}]);
        let model = Server::new(vec![stream("openai-responses", "text")]);
        let f = Fixture::new(&model);
        grok_config(&f, &idp.url, &model.url, &version.url, true);
        let mut token = raw_token(&f);
        match mode {
            "no-api" => token["scope"] = json!("grok-cli:access"),
            "issuer" => token["issuer"] = json!("https://foreign.invalid"),
            "client" => token["clientId"] = json!("foreign-client"),
            "provider" => token["provider"] = json!("openai"),
            _ => {}
        }
        vault(&f, "set", Some(&token));
        let before = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
        let output = command(&f, "p").output().unwrap();
        assert!(!output.status.success(), "{mode}");
        assert!(model.requests.lock().unwrap().is_empty());
        assert!(idp.requests.lock().unwrap().is_empty());
        assert_eq!(
            std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
            before
        );
        let good = Server::new(vec![plain("200 OK", "1.0.77")]);
        token["provider"] = json!("grok");
        token["issuer"] = json!("https://auth.x.ai");
        token["clientId"] = json!("b1a00492-073a-47ea-816f-4c329264a828");
        token["scope"] = json!("grok-cli:access api:access");
        vault(&f, "set", Some(&token));
        let file = f.root.path().join(".native-model-oauth-fixture.json");
        let mut data = get(&file);
        data["versionUrl"] = json!(good.url);
        put(file, &data);
        next(&f);
        let output = command(&f, "next").output().unwrap();
        assert!(
            output.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(model.requests.lock().unwrap().len(), 1);
    }
}
#[test]
fn a_rotated_credential_during_compatibility_wait_is_checked_before_model_post() {
    let idp = Idp::new(refreshed(), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/version", listener.local_addr().unwrap());
    let (received, ready) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let worker = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (_, _, headers, _) = read_request(&mut socket);
        assert!(headers.starts_with("GET "));
        assert!(!headers.to_ascii_lowercase().contains("authorization:"));
        received.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        let _ = socket.write_all(plain("200 OK", "1.0.77").as_bytes());
    });
    grok_config(&f, &idp.url, &model.url, &url, true);
    let before = raw_token(&f);
    let child = OwnedChild(Some(command(&f, "p").spawn().unwrap()));
    ready.recv_timeout(Duration::from_secs(8)).unwrap();
    let mut replacement = before.clone();
    replacement["access"] = json!("another-login");
    vault(&f, "set", Some(&replacement));
    release.send(()).unwrap();
    let output = wait_output(child);
    worker.join().unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("model_credential_changed"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(model.requests.lock().unwrap().is_empty());
    assert_eq!(raw_token(&f), replacement);
}
#[test]
fn changed_refresh_scope_preserves_the_actual_reservation_and_does_not_dispatch_inference() {
    for returned in ["openid", "api:access grok-cli:access added"] {
        let idp = Idp::new(
            json!({"access_token":"must-not-use","expires_in":3600,"scope":returned}).to_string(),
            "200 OK",
            false,
            false,
        );
        let version = Server::new(vec![plain("200 OK", "1.0.77")]);
        let model = Server::new(vec![]);
        let f = Fixture::new(&model);
        grok_config(&f, &idp.url, &model.url, &version.url, false);
        let before = raw_token(&f);
        let output = command(&f, "p").output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("model_oauth_scope_changed"));
        assert!(model.requests.lock().unwrap().is_empty());
        let mut pending = raw_token(&f);
        let marker = pending
            .as_object_mut()
            .unwrap()
            .remove("peerModelRefresh")
            .unwrap();
        assert_eq!(marker["authMethod"], "oauth_grok");
        assert_eq!(pending, before);
        assert_eq!(idp.requests.lock().unwrap().len(), 1);
        next(&f);
        let output = command(&f, "next").output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("model_oauth_refresh_pending"));
        assert_eq!(idp.requests.lock().unwrap().len(), 1);
    }
}
