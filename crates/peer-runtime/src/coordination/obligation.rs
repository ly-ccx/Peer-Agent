//! Follow-up dispositions/grants never create stop receipts or release claims.
use super::{
    bucket, id, put,
    value::{list, num, truth},
};
use serde_json::{Value, json};
pub(super) fn reduce(mut next: Value, e: &Value) -> Result<Value, &'static str> {
    if e["minimumExecutorVersion"] != 11 {
        return Err("obligation_executor_unsupported");
    }
    match e["kind"].as_str().unwrap_or("") {
        "obligation_grant" => {
            let grant = &e["grant"];
            let key = id(&grant["grantId"]).map_err(|_| "obligation_grant_invalid")?;
            let old = &next["obligationGrants"][key];
            if !["pending", "confirmed", "revoked", "expired"]
                .contains(&grant["status"].as_str().unwrap_or(""))
                || !grant["items"].is_array()
                || list(&grant["items"]).is_empty()
                || list(&grant["items"]).len() > 20
                || list(&grant["items"]).iter().any(|item| {
                    !item["sessionId"].is_string()
                        || !item["operationId"].is_string()
                        || !item["evidenceRevision"].is_string()
                        || !item["actions"].is_array()
                        || list(&item["actions"]).iter().any(|a| {
                            ![
                                "retire_follow_up",
                                "acknowledge_unknown",
                                "restore_follow_up",
                                "close_claim",
                            ]
                            .contains(&a.as_str().unwrap_or(""))
                        })
                })
                || num(&grant["revision"]) != num(&old["revision"]).unwrap_or(0).checked_add(1)
            {
                return Err("obligation_grant_invalid");
            }
            if old.is_null() {
                if grant["status"] != "pending" {
                    return Err("obligation_grant_invalid");
                }
            } else {
                if truth(&old["canonicalKey"]) && old["canonicalKey"] != grant["canonicalKey"]
                    || old["principal"]["workspaceId"] != grant["principal"]["workspaceId"]
                    || old["principal"]["parentConversationId"]
                        != grant["principal"]["parentConversationId"]
                {
                    return Err("obligation_grant_invalid");
                }
                if ["revoked", "expired"].contains(&old["status"].as_str().unwrap_or(""))
                    && grant["status"] == "confirmed"
                    || old["status"] == "confirmed" && grant["status"] == "pending"
                {
                    return Err("obligation_grant_replay_forbidden");
                }
            }
            put(&mut next, "obligationGrants", key, grant.clone())?;
        }
        "execution_obligation" => {
            let row = &e["disposition"];
            let key = row["obligationId"]
                .as_str()
                .ok_or("obligation_disposition_invalid")?;
            let old = &next["obligationDispositions"][key];
            if !row["sessionId"].is_string()
                || !row["operationId"].is_string()
                || !["indexed", "suspended", "current"]
                    .contains(&row["phase"].as_str().unwrap_or(""))
                || num(&row["revision"]) != num(&old["revision"]).unwrap_or(0).checked_add(1)
                || ["suspended", "current"].contains(&row["phase"].as_str().unwrap_or(""))
                    && old["phase"] != "indexed"
            {
                return Err("obligation_disposition_invalid");
            }
            let session = row["sessionId"].as_str().unwrap();
            put(&mut next, "obligationDispositions", key, row.clone())?;
            put(&mut next, "obligationHeads", session, json!(key))?;
            bucket(&mut next, "obligationResults")?;
            if truth(&e["audit"]["auditId"]) {
                put(
                    &mut next,
                    "obligationResults",
                    id(&e["audit"]["auditId"])?,
                    e["audit"].clone(),
                )?;
            }
        }
        _ => return Err("obligation_event_invalid"),
    }
    Ok(next)
}
