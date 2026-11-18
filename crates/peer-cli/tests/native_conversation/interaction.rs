use super::*;

fn question() -> Value {
    json!({"question":"Choose a fixture","options":["one","two"]})
}

#[test]
fn headless_question_is_projected_denied_and_ends_the_batch() {
    let fixture = Ordinary::new();
    let hooks = fixture.workspace().join(".peer/hooks.json");
    std::fs::create_dir_all(hooks.parent().unwrap()).unwrap();
    put(
        hooks,
        &json!({"hooks":{"PreToolUse":[{
            "id":"interaction-pre","command":"printf effect > unexpected-hook",
            "match":{"capabilityId":"local.interaction.request_user_input"}
        }]}}),
    );
    let server = Server::new(vec![format!(
        "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"id":"request-question","type":"function","function":{
                "name":"request_user_input","arguments":question().to_string()
            }},
            {"index":1,"id":"later-write","type":"function","function":{
                "name":"write_file","arguments":json!({"path":"unexpected-write","content":"effect"}).to_string()
            }}
        ]},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}})
    )]);
    let output = fixture.run(
        Some(&server),
        &[
            "--access",
            "full",
            "--output-format",
            "json",
            "--tools",
            "local.interaction.request_user_input,write_file",
            "Choose a fixture",
        ],
        None,
    );
    assert!(output.status.success(), "{output:?}");
    let reply = fixture.assert_settled(&output, 1, 1);
    assert_eq!(reply["ok"], true);
    assert!(reply["result"].is_null());
    assert!(reply["error"].is_null());
    let history = ConversationStore::new(fixture.home())
        .read_committed(reply["sessionId"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    let (row, segment) = history
        .history
        .messages
        .iter()
        .find_map(|row| {
            row["segments"]
                .as_array()?
                .iter()
                .find(|seg| seg["tool"] == "request_user_input")
                .map(|seg| (row, seg))
        })
        .unwrap();
    let result = &segment["result"];
    let grant = &row["permissionGrants"][0];
    assert_eq!(segment["args"], question());
    assert_eq!(
        result["capabilityId"],
        "local.interaction.request_user_input"
    );
    assert_eq!(result["status"], "denied");
    assert_eq!(result["error"]["code"], "request_user_input_unavailable");
    assert_eq!(result["evidence"]["dispatchOutcome"], "not_dispatched");
    assert_eq!(result["evidence"]["permissionGrantId"], grant["grantId"]);
    assert_eq!(grant["granted"], false);
    assert_eq!(grant["reason"], "request_user_input_unavailable");
    assert!(!fixture.workspace().join("unexpected-write").exists());
    assert!(!fixture.workspace().join("unexpected-hook").exists());
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let tools = requests[0]["tools"].as_array().unwrap();
    let manifest = tools
        .iter()
        .find(|tool| tool["function"]["name"] == "request_user_input")
        .unwrap();
    assert_eq!(
        manifest["function"]["parameters"]["required"],
        json!(["question"])
    );
    assert!(
        tools
            .iter()
            .any(|tool| tool["function"]["name"] == "write_file")
    );
}

#[test]
fn ordinary_goal_runner_settles_a_denied_question_without_waiting() {
    let fixture = Ordinary::new();
    let server = Server::new(vec![
        reply_tool(
            "goal_create_plan",
            json!({"title":"Read fixture","goal":"Inspect a fixture file","tasks":[{"title":"Read a file"}]}),
        ),
        reply_text("Goal recorded."),
        reply_tool("request_user_input", question()),
    ]);
    let output = fixture.run(
        Some(&server),
        &[
            "--mode",
            "goal",
            "--output-format",
            "json",
            "Inspect a fixture",
        ],
        None,
    );
    assert_eq!(output.status.code(), Some(6), "{output:?}");
    let reply = fixture.assert_settled(&output, 3, 2);
    assert_eq!(reply["goal"]["runnerStatus"], "blocked");
    assert_eq!(
        reply["goal"]["exitReason"],
        "request_user_input_unavailable"
    );
    assert_eq!(server.requests.lock().unwrap().len(), 3);
}
