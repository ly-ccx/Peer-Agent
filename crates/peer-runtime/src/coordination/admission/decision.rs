use super::*;
pub fn admit_coordination_decision(state: &Value, d: &Value, h: &Value) -> Value {
    if !bounded(state, d, h) {
        return fail("coordination_state_limit");
    }
    if !ACTIONS.contains(&d["action"].as_str().unwrap_or(""))
        || !id(&d["operationId"])
        || !id(&d["workId"])
        || !text(&d["reason"], usize::MAX)
        || num(&d["expectedRevision"]).is_none()
        || !d["sourceInputIds"].is_array()
        || !d["sourceEventIds"].is_array()
    {
        return fail("invalid_coordination_decision");
    }
    if !allowed(
        d,
        &[
            "operationId",
            "workId",
            "expectedRevision",
            "action",
            "sourceInputIds",
            "sourceEventIds",
            "sourceDecisionRef",
            "sessionId",
            "reason",
            "payload",
        ],
    ) {
        return fail("untrusted_coordination_authority");
    }
    if !truth(&h["holdsLease"]) || !truth(&h["workspaceId"]) || !truth(&h["parentConversationId"]) {
        return fail("coordination_lease_lost");
    }
    let digest = hash(d).unwrap();
    let work = d["workId"].as_str().unwrap();
    let operation = d["operationId"].as_str().unwrap();
    let prior = &state["mandates"][work];
    let old = &state["decisions"][operation];
    if truth(prior)
        && (prior["workspaceId"] != h["workspaceId"]
            || prior["parentConversationId"] != h["parentConversationId"])
    {
        return fail("out_of_scope");
    }
    if truth(old) {
        return if old["digest"] == digest {
            json!({"ok":true,"replayed":true,"receipt":old})
        } else {
            fail("operation_identity_conflict")
        };
    }
    if num(&prior["goalRevision"]).unwrap_or(0) != num(&d["expectedRevision"]).unwrap() {
        return fail("goal_revision_conflict");
    }
    let inputs = unique(list(&d["sourceInputIds"]).to_vec());
    let events = unique(list(&d["sourceEventIds"]).to_vec());
    if inputs.iter().any(|id| !contains(&h["currentInputIds"], id))
        || events.iter().any(|id| !contains(&h["eventIds"], id))
    {
        return fail("source_not_admitted");
    }
    let intent = &state["works"][work]["intentCoordination"];
    if truth(intent) && intent["lifecycle"] != "active" {
        return fail("mandate_inactive");
    }
    let source = &d["sourceDecisionRef"];
    let source_old = source
        .as_str()
        .and_then(|s| state["intentDecisions"].get(s))
        .unwrap_or(&Value::Null);
    let continuation = inputs.is_empty()
        && events.is_empty()
        && truth(source)
        && source == &h["sourceDecisionRef"]
        && intent["lifecycle"] == "active"
        && intent["goalRevision"] == prior["goalRevision"]
        && (intent["decision"]["operationId"] == *source
            && intent["decision"]["disposition"]["kind"] == "continue"
            || id(&h["turnId"])
                && intent["decisionTurnId"] == h["turnId"]
                && source == &h["originDecisionRef"]
                && source_old["continuation"] == true
                && source_old["goalRevision"] == prior["goalRevision"]);
    if inputs.is_empty() && events.is_empty() && !continuation {
        return fail("coordination_source_required");
    }
    if inputs.is_empty() && (!truth(prior) || prior["lifecycle"] != "active") {
        return fail("mandate_inactive");
    }
    let adopted = !truth(prior)
        && !inputs.is_empty()
        && truth(&d["sessionId"])
        && contains(&h["adoptSessionIds"], &d["sessionId"]);
    if !truth(prior) && (inputs.is_empty() || d["action"] != "parallel" && !adopted) {
        return fail("mandate_required");
    }
    if prior["lifecycle"] == "fulfilled"
        || prior["lifecycle"] == "cancelled" && !(d["action"] == "cancel" && !inputs.is_empty())
    {
        return fail("mandate_inactive");
    }
    if truth(&d["sessionId"])
        && (!(contains(&prior["sessionIds"], &d["sessionId"]) || adopted)
            || h.get("scopedSessionIds").is_some_and(truth)
                && !contains(&h["scopedSessionIds"], &d["sessionId"]))
    {
        return fail("out_of_scope");
    }
    if inputs.is_empty()
        && events.iter().any(|id| {
            let session = &state["events"][id.as_str().unwrap_or("")]["event"]["sessionId"];
            !contains(&prior["sessionIds"], session)
                || contains(&prior["revokedSessionIds"], session)
        })
    {
        return fail("event_out_of_scope");
    }
    if truth(prior)
        && !contains(&prior["allowedActions"], &d["action"])
        && !(d["action"] == "resume" && contains(&prior["allowedActions"], &json!("handoff")))
    {
        return fail("coordination_action_denied");
    }
    if h.get("scopedSessionIds").is_some_and(truth)
        && truth(prior)
        && !list(&prior["sessionIds"])
            .iter()
            .any(|id| contains(&h["scopedSessionIds"], id))
    {
        return fail("out_of_scope");
    }
    let materials = unique(list(&h["materialRefs"]).to_vec());
    if inputs.is_empty()
        && materials
            .iter()
            .any(|r| !contains(&prior["materialRefs"], r))
    {
        return fail("material_out_of_scope");
    }
    let revision = if truth(prior) {
        num(&prior["goalRevision"]).unwrap_or(0)
            + u64::from(
                ["revise", "cancel", "replace"].contains(&d["action"].as_str().unwrap_or("")),
            )
    } else {
        1
    };
    let mut bindings = if prior["executionBindings"].is_object() {
        prior["executionBindings"].clone()
    } else {
        json!({})
    };
    let revoke = truth(&d["sessionId"])
        && ["revise", "cancel", "replace", "handoff", "resume"]
            .contains(&d["action"].as_str().unwrap_or(""));
    if revoke {
        remove(&mut bindings, d["sessionId"].as_str().unwrap_or(""));
    }
    let mandate_id = field_or(prior, "mandateId", &Value::Null)
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "mandate-{}",
                hash(&json!([h["workspaceId"], d["workId"]])).unwrap()
            )
        });
    let mut mandate = json!({"schemaVersion":1,"mandateId":mandate_id,"workId":d["workId"],"workspaceId":h["workspaceId"],"parentConversationId":h["parentConversationId"],"rootInputIds":field_or(prior,"rootInputIds",&json!(inputs)),"revisionInputIds":unique(list(&prior["revisionInputIds"]).iter().cloned().chain(inputs.clone()).collect::<Vec<_>>()),"goalRevision":revision,"allowedActions":field_or(prior,"allowedActions",&json!(ACTIONS)),"sessionIds":field_or(prior,"sessionIds",&if adopted{json!([d["sessionId"]])}else{json!([])}),"materialRefs":unique(list(&prior["materialRefs"]).iter().cloned().chain(materials).collect::<Vec<_>>()),"policyRevision":field_or(h,"policyRevision",&json!("existing-project-policy")),"executionBindings":bindings,"revokedSessionIds":unique(list(&prior["revokedSessionIds"]).iter().cloned().chain(if revoke{vec![d["sessionId"].clone()]}else{vec![]}).collect::<Vec<_>>()),"lifecycle":if prior["lifecycle"]=="cancelled"{"cancelled"}else{"active"}});
    if prior["intentSchemaVersion"] == 1 || h["intentRequired"] == true {
        mandate["intentSchemaVersion"] = json!(1);
    }
    let mut transition = json!({"schemaVersion":1,"operationId":d["operationId"],"workId":d["workId"],"mandateId":mandate_id,"expectedGoalRevision":revision,"sourceInputIds":inputs,"sourceEventIds":events,"initiator":"project_agent","decisionSource":if !inputs.is_empty(){"user_revision"}else{"execution_repair"},"action":d["action"],"reason":d["reason"],"executionEpoch":format!("execution-{}",hash(&json!([d["workId"],revision,d["operationId"]])).unwrap()),"phase":"recorded","minimumExecutorVersion":if d["payload"]["repair"]==true{3}else if d["action"]=="resume"{2}else{1},"updatedAt":h["now"]});
    if truth(&d["sessionId"]) {
        transition["oldSessionId"] = d["sessionId"].clone();
    }
    let mut receipt = d.clone();
    receipt["digest"] = json!(digest);
    receipt["goalRevision"] = json!(revision);
    receipt["mandateId"] = json!(mandate_id);
    json!({"ok":true,"entry":{"kind":"coordination_decision","mandate":mandate,"receipt":receipt,"transition":transition},"receipt":receipt})
}
