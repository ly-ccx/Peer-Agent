use super::*;
pub fn admit_intent_assessment(state: &Value, a: &Value, h: &Value) -> Value {
    if !bounded(state, a, h) {
        return fail("coordination_state_limit");
    }
    if !intent_kernel::assessment(a) {
        return fail("invalid_intent_assessment");
    }
    if !truth(&h["holdsLease"]) || !truth(&h["workspaceId"]) || !truth(&h["parentConversationId"]) {
        return fail("coordination_lease_lost");
    }
    let work = &state["works"][a["workId"].as_str().unwrap()];
    let mandate = &state["mandates"][a["workId"].as_str().unwrap()];
    if !truth(work)
        || work["workspaceId"] != h["workspaceId"]
        || work["parentConversationId"] != h["parentConversationId"]
    {
        return fail("out_of_scope");
    }
    let old = &state["intentDecisions"][a["operationId"].as_str().unwrap()];
    let digest = sorted_digest(a).unwrap();
    if truth(old) {
        return if digest_matches(&old["digest"], a) && old["workId"] == work["workId"] {
            json!({"ok":true,"replayed":true,"receipt":old})
        } else {
            fail("operation_identity_conflict")
        };
    }
    let prior = &work["intentCoordination"];
    if matches!(
        work["state"].as_str(),
        Some("paused" | "cancelled" | "coalesced")
    ) || truth(prior) && prior["lifecycle"] != "active"
    {
        return fail("work_execution_stopped");
    }
    if num(&prior["revision"]).unwrap_or(0) != num(&a["expectedWorkRevision"]).unwrap() {
        return fail("work_revision_conflict");
    }
    let revision = num(&mandate["goalRevision"]).unwrap_or(0);
    if Some(revision) != num(&a["expectedGoalRevision"]) {
        return fail("goal_revision_conflict");
    }
    let inputs = list(&a["sourceInputIds"]);
    let events = list(&a["sourceEventIds"]);
    if inputs.iter().any(|id| !contains(&h["currentInputIds"], id))
        || events.iter().any(|id| !contains(&h["eventIds"], id))
    {
        return fail("source_not_admitted");
    }
    let decision = &state["intentDecisions"][a["sourceDecisionRef"].as_str().unwrap_or("")];
    let source = decision["workId"] == work["workId"]
        && prior["decision"]["operationId"] == decision["operationId"]
        && prior["goalRevision"] == json!(revision)
        && prior["decision"]["disposition"]["kind"] == "continue";
    let same_turn = decision["workId"] == work["workId"]
        && decision["goalRevision"] == json!(revision)
        && decision["continuation"] == true
        && text(&h["turnId"], 200)
        && h["originDecisionRef"] == decision["operationId"]
        && prior["decisionTurnId"] == h["turnId"];
    if inputs.is_empty()
        && (!truth(mandate)
            || mandate["lifecycle"] != "active"
            || events.is_empty() && !source && !same_turn)
    {
        return fail("intent_source_required");
    }
    if events.iter().any(|id| {
        let session = &state["events"][id.as_str().unwrap_or("")]["event"]["sessionId"];
        !contains(&mandate["sessionIds"], session)
            || contains(&mandate["revokedSessionIds"], session)
    }) {
        return fail("event_out_of_scope");
    }
    if list(&a["inputs"]).len() != inputs.len()
        || inputs
            .iter()
            .any(|id| !list(&a["inputs"]).iter().any(|r| r["inputId"] == *id))
    {
        return fail("input_disposition_required");
    }
    let interpretation = field_or(a, "interpretation", &prior["interpretation"]);
    if !truth(interpretation) {
        return fail("intent_interpretation_required");
    }
    let admitted: Vec<_> = [
        &mandate["rootInputIds"],
        &mandate["revisionInputIds"],
        &work["anchorInputIds"],
        &a["sourceInputIds"],
    ]
    .into_iter()
    .flat_map(list)
    .collect();
    if list(&interpretation["requirements"]).iter().any(|r| {
        list(&r["sourceInputIds"])
            .iter()
            .any(|id| !admitted.contains(&id))
    }) {
        return fail("intent_source_out_of_scope");
    }
    if truth(prior)
        && truth(&a["interpretation"])
        && sorted_digest(&prior["interpretation"]) != sorted_digest(&a["interpretation"])
        && (inputs.is_empty() || prior["goalRevision"] == json!(revision))
    {
        return fail("intent_revision_required");
    }
    let requirements = list(&interpretation["requirements"]);
    if list(&a["coverage"]).len() != requirements.len()
        || requirements.iter().any(|r| {
            !list(&a["coverage"])
                .iter()
                .any(|c| c["requirementId"] == r["requirementId"])
        })
    {
        return fail("goal_coverage_incomplete");
    }
    if list(&a["coverage"]).iter().any(|c| {
        list(&c["sources"])
            .iter()
            .any(|s| !contains(&mandate["sessionIds"], &s["sessionId"]))
    }) {
        return fail("coverage_out_of_scope");
    }
    let mut receipt = json!({"operationId":a["operationId"],"workId":work["workId"],"digest":digest,"workRevision":num(&a["expectedWorkRevision"]).unwrap()+1,"goalRevision":revision,"at":h["now"],"continuation":a["disposition"]["kind"]=="continue"});
    if truth(&h["turnId"]) {
        receipt["turnId"] = h["turnId"].clone();
    }
    json!({"ok":true,"receipt":receipt,"entry":{"kind":"intent_assessed","minimumExecutorVersion":9,"workId":work["workId"],"assessment":a,"receipt":receipt}})
}
pub fn admit_intent_closure(state: &Value, r: &Value, h: &Value) -> Value {
    if !bounded(state, r, h) {
        return fail("coordination_state_limit");
    }
    if !truth(&h["holdsLease"]) {
        return fail("coordination_lease_lost");
    }
    let work = &state["works"][r["workId"].as_str().unwrap_or("")];
    let intent = &work["intentCoordination"];
    if !truth(intent)
        || work["workspaceId"] != h["workspaceId"]
        || work["parentConversationId"] != h["parentConversationId"]
    {
        return fail("out_of_scope");
    }
    let old = &state["intentDecisions"][r["operationId"].as_str().unwrap_or("")];
    if truth(old) {
        return if old["workId"] == work["workId"]
            && old["goalRevision"] == r["expectedGoalRevision"]
            && num(&old["workRevision"])
                == num(&r["expectedWorkRevision"]).and_then(|n| n.checked_add(1))
            && old["lifecycle"] == r["lifecycle"]
        {
            json!({"ok":true,"replayed":true,"receipt":old})
        } else {
            fail("operation_identity_conflict")
        };
    }
    if !text(&r["operationId"], 200)
        || intent["lifecycle"] != "active"
        || r["expectedWorkRevision"] != intent["revision"]
        || r["expectedGoalRevision"] != intent["goalRevision"]
        || num(&intent["goalRevision"])
            != Some(
                num(&state["mandates"][work["workId"].as_str().unwrap_or("")]["goalRevision"])
                    .unwrap_or(0),
            )
    {
        return fail("intent_closure_conflict");
    }
    let mut receipt = json!({"operationId":r["operationId"],"workId":work["workId"],"workRevision":num(&intent["revision"]).unwrap_or(0)+1,"goalRevision":intent["goalRevision"],"lifecycle":r["lifecycle"],"at":h["now"]});
    if r["lifecycle"] == "fulfilled" {
        if intent["decision"]["disposition"]["kind"] != "return"
            || !list(&intent["interpretation"]["openQuestions"]).is_empty()
            || list(&intent["coverage"])
                .iter()
                .any(|c| c["status"] != "covered")
        {
            return fail("goal_coverage_incomplete");
        }
        let replies = intent_kernel::delivered_reply_refs(state, work, None);
        if replies.is_empty() {
            return fail("goal_delivery_pending");
        }
        let review = &intent["review"];
        if h["pendingObligations"] != false
            || h["verifiedGoalRevision"] != intent["goalRevision"]
            || !text(&h["reviewRef"], 200)
            || review["passed"] != true
            || review["reviewRef"] != h["reviewRef"]
            || review["goalRevision"] != intent["goalRevision"]
            || review["intentRevision"] != intent["revision"]
        {
            return fail("goal_review_required");
        }
        receipt["replyRef"] = replies[0].clone();
        receipt["replyRefs"] = json!(replies);
        receipt["intentReplyRef"] = intent["decision"]["disposition"]["replyRef"].clone();
        receipt["reviewRef"] = h["reviewRef"].clone();
    } else {
        let reference = &intent["decision"]["disposition"]["controlRef"];
        let control = &state["transitions"][reference.as_str().unwrap_or("")];
        if r["lifecycle"] != "cancelled"
            || intent["decision"]["disposition"]["kind"] != "withdraw"
            || h["appliedControlRef"] != *reference
            || h["pendingManagedSessions"] != false
            || control["workId"] != work["workId"]
            || control["action"] != "cancel"
            || control["phase"] != "completed"
            || control["expectedGoalRevision"] != intent["goalRevision"]
        {
            return fail("goal_control_required");
        }
        receipt["controlRef"] = h["appliedControlRef"].clone();
    }
    json!({"ok":true,"receipt":receipt,"entry":{"kind":"intent_closed","minimumExecutorVersion":9,"workId":work["workId"],"receipt":receipt}})
}
