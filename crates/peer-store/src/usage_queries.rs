//! Desktop-compatible usage statistics, daily heatmap, day drilldown, and cache-hit-rate queries.
//! Pure read-only aggregation over `<data_home>/usage/requests.jsonl`, `conversations/index.jsonl`,
//! and `llm-providers.json` (pricing / labels only, never reading secrets).

use crate::{ConversationStore, conversation_crud::ConversationListQuery, files};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap},
    io::{Read, Seek, SeekFrom},
    path::Path,
};
use time::{Date, Duration, OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

const MAX_TAIL_BYTES: usize = 8 * 1024 * 1024;
const CHUNK_BYTES: usize = 64 * 1024;
const MAX_READ_LIMIT: usize = 50_000;
const STEADY_TTL_MS: i128 = 5 * 60 * 1000;
const TOKENS_PER_MILLION: f64 = 1_000_000.0;
const UNBOUND_PROVIDER_KEY: &str = "unbound";
const UNBOUND_PROVIDER_LABEL: &str = "未绑定 Provider";
const UNBOUND_MODEL_LABEL: &str = "未绑定模型";

fn finite_f64(value: &Value) -> f64 {
    value.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0)
}

fn optional_f64(value: &Value) -> Option<f64> {
    if value.is_null() {
        return None;
    }
    if let Some(n) = value.as_f64() {
        return n.is_finite().then_some(n);
    }
    if let Some(s) = value.as_str() {
        let trimmed = peer_protocol::javascript_trim(s);
        if trimmed.is_empty() {
            return None;
        }
        return trimmed.parse::<f64>().ok().filter(|n| n.is_finite());
    }
    None
}

fn trimmed_str(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(peer_protocol::javascript_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn parse_offset(local_offset_minutes: i32) -> UtcOffset {
    let clamped_mins = local_offset_minutes.clamp(-14 * 60, 14 * 60);
    UtcOffset::from_whole_seconds(clamped_mins * 60).unwrap_or(UtcOffset::UTC)
}

fn parse_now_or_utc(now: Option<&str>) -> OffsetDateTime {
    now.and_then(|raw| OffsetDateTime::parse(raw, &Rfc3339).ok())
        .unwrap_or_else(OffsetDateTime::now_utc)
}

fn to_local_date(at: Option<&str>, fallback: OffsetDateTime, offset: UtcOffset) -> Option<Date> {
    let dt = match at {
        Some(raw) if !raw.trim().is_empty() => OffsetDateTime::parse(raw.trim(), &Rfc3339).ok()?,
        None => fallback,
        Some(_) => return None,
    };
    Some(dt.to_offset(offset).date())
}

fn to_local_datetime(at: &str, offset: UtcOffset) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(at.trim(), &Rfc3339)
        .ok()
        .map(|dt| dt.to_offset(offset))
}

fn format_date_ymd(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        date.month() as u8,
        date.day()
    )
}

fn parse_ymd(raw: &str) -> Option<Date> {
    let parts: Vec<&str> = raw.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return None;
    }
    let year: i32 = parts[0].parse().ok()?;
    let month: u8 = parts[1].parse().ok()?;
    let day: u8 = parts[2].parse().ok()?;
    let month = time::Month::try_from(month).ok()?;
    Date::from_calendar_date(year, month, day).ok()
}

pub fn read_usage_request_tail(data_home: &Path, max_rows: usize) -> Vec<Value> {
    let file_path = data_home.join("usage").join("requests.jsonl");
    let Ok(Some((mut file, ident))) = files::open(&file_path, u64::MAX) else {
        return Vec::new();
    };
    let limit = max_rows.clamp(1, MAX_READ_LIMIT);
    let mut position = ident.size;
    let mut bytes_read = 0usize;
    let mut newlines = 0usize;
    let mut chunks: Vec<Vec<u8>> = Vec::new();

    while position > 0 && bytes_read < MAX_TAIL_BYTES && newlines <= limit {
        let size = (CHUNK_BYTES as u64)
            .min(position)
            .min((MAX_TAIL_BYTES - bytes_read) as u64) as usize;
        if size == 0 {
            break;
        }
        position -= size as u64;
        if file.seek(SeekFrom::Start(position)).is_err() {
            break;
        }
        let mut buf = vec![0u8; size];
        let Ok(count) = file.read(&mut buf) else {
            break;
        };
        if count == 0 {
            break;
        }
        buf.truncate(count);
        newlines += buf.iter().filter(|&&b| b == b'\n').count();
        bytes_read += count;
        chunks.push(buf);
        if count < size {
            break;
        }
    }

    let total_len: usize = chunks.iter().map(Vec::len).sum();
    let mut combined = Vec::with_capacity(total_len);
    for chunk in chunks.iter().rev() {
        combined.extend_from_slice(chunk);
    }

    let mut lines: Vec<&[u8]> = combined
        .split(|&b| b == b'\n')
        .filter(|slice| !slice.iter().all(u8::is_ascii_whitespace))
        .collect();
    if position > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let start = lines.len().saturating_sub(limit);
    let mut rows = Vec::with_capacity(lines.len() - start);
    for slice in &lines[start..] {
        if let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(slice) {
            rows.push(Value::Object(map));
        }
    }

    fold_prediction_usage(rows)
}

fn fold_prediction_usage(rows: Vec<Value>) -> Vec<Value> {
    let mut latest_idx: HashMap<String, usize> = HashMap::new();
    for (idx, row) in rows.iter().enumerate() {
        if row["requestPurpose"].as_str() == Some("input_prediction")
            && let Some(id) = row["id"].as_str()
        {
            latest_idx.insert(id.to_owned(), idx);
        }
    }
    rows.into_iter()
        .enumerate()
        .filter(|(idx, row)| {
            if row["requestPurpose"].as_str() != Some("input_prediction") {
                return true;
            }
            match row["id"].as_str() {
                Some(id) => latest_idx.get(id) == Some(idx),
                None => true,
            }
        })
        .map(|(_, row)| row)
        .collect()
}

fn load_flattened_providers(data_home: &Path) -> Vec<Value> {
    let path = data_home.join("llm-providers.json");
    let Ok(Some(bytes)) = files::read(&path, 4 * 1024 * 1024) else {
        return Vec::new();
    };
    let Ok(doc) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    if let Some(arr) = doc.as_array() {
        return arr.clone();
    }
    if let Some(arr) = doc["providers"].as_array() {
        return arr.clone();
    }
    let Some(channels_arr) = doc["channels"].as_array() else {
        return Vec::new();
    };
    let Some(models_arr) = doc["models"].as_array() else {
        return Vec::new();
    };
    let mut channels: HashMap<String, Value> = HashMap::new();
    for ch in channels_arr {
        if let Some(id) = trimmed_str(&ch["id"]).or_else(|| trimmed_str(&ch["groupId"])) {
            channels.insert(id, ch.clone());
        }
    }
    let mut out = Vec::new();
    for m in models_arr {
        let Some(gid) = trimmed_str(&m["groupId"]).or_else(|| trimmed_str(&m["id"])) else {
            continue;
        };
        let mut merged = channels
            .get(&gid)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(m_obj) = m.as_object() {
            for (k, v) in m_obj {
                merged.insert(k.clone(), v.clone());
            }
        }
        merged.insert("groupId".into(), json!(gid));
        out.push(Value::Object(merged));
    }
    out
}

struct ProviderIndex {
    by_id: HashMap<String, Value>,
    by_group_id: HashMap<String, Value>,
    by_composite: HashMap<String, Value>,
}

impl ProviderIndex {
    fn from_providers(providers: &[Value]) -> Self {
        let mut by_id = HashMap::new();
        let mut by_group_id = HashMap::new();
        let mut by_composite = HashMap::new();
        for p in providers {
            let id = trimmed_str(&p["id"]).unwrap_or_default();
            let group_id = trimmed_str(&p["groupId"])
                .or_else(|| (!id.is_empty()).then(|| id.clone()))
                .unwrap_or_default();
            let model = trimmed_str(&p["model"]).unwrap_or_default();
            if !id.is_empty() {
                by_id.insert(id.clone(), p.clone());
            }
            if !group_id.is_empty() {
                by_group_id
                    .entry(group_id.clone())
                    .or_insert_with(|| p.clone());
                by_id.entry(group_id.clone()).or_insert_with(|| p.clone());
            }
            if !group_id.is_empty() && !model.is_empty() {
                by_composite.insert(format!("{group_id}::{model}"), p.clone());
            }
        }
        Self {
            by_id,
            by_group_id,
            by_composite,
        }
    }
}

fn split_composite_provider_id(id: &str) -> (String, String) {
    match id.split_once("::") {
        Some((g, m)) => (
            peer_protocol::javascript_trim(g).to_owned(),
            peer_protocol::javascript_trim(m).to_owned(),
        ),
        None => (String::new(), String::new()),
    }
}

fn provider_group_key(p: &Value) -> String {
    trimmed_str(&p["groupId"])
        .or_else(|| trimmed_str(&p["id"]))
        .unwrap_or_default()
}

fn provider_model_label(p: &Value) -> String {
    trimmed_str(&p["modelLabel"])
        .or_else(|| trimmed_str(&p["model"]))
        .unwrap_or_default()
}

#[derive(Default, Clone)]
struct FullTokenBucket {
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    total_tokens: f64,
}

impl FullTokenBucket {
    fn from_row(row: &Value) -> Self {
        let input_tokens = finite_f64(&row["inputTokens"]);
        let output_tokens = finite_f64(&row["outputTokens"]);
        let cache_read_tokens = finite_f64(&row["cacheReadTokens"]);
        let cache_write_tokens = finite_f64(&row["cacheWriteTokens"]);
        let explicit_total = finite_f64(&row["totalTokens"]);
        let total_tokens = if explicit_total != 0.0 {
            explicit_total
        } else {
            input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
        };
        Self {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            total_tokens,
        }
    }

    fn is_zero_io(&self) -> bool {
        self.input_tokens == 0.0
            && self.output_tokens == 0.0
            && self.cache_read_tokens == 0.0
            && self.cache_write_tokens == 0.0
    }

    fn add(&mut self, other: &Self) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
        self.total_tokens += other.total_tokens;
    }
}

#[derive(Clone)]
struct GroupRow {
    key: String,
    label: String,
    provider_id: Option<String>,
    provider_name: Option<String>,
    model: Option<String>,
    include_provider_fields: bool,
    include_model: bool,
    include_request_count: bool,
    conversation_count: u64,
    request_count: u64,
    bucket: FullTokenBucket,
    estimated_cost_usd: f64,
    has_pricing: bool,
}

impl GroupRow {
    fn to_json(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("key".into(), json!(self.key));
        obj.insert("label".into(), json!(self.label));
        if self.include_provider_fields {
            obj.insert(
                "providerId".into(),
                self.provider_id
                    .as_ref()
                    .map(|s| json!(s))
                    .unwrap_or(Value::Null),
            );
            obj.insert(
                "providerName".into(),
                self.provider_name
                    .as_ref()
                    .map(|s| json!(s))
                    .unwrap_or(Value::Null),
            );
        }
        if self.include_model {
            obj.insert(
                "model".into(),
                self.model.as_ref().map(|m| json!(m)).unwrap_or(Value::Null),
            );
        }
        obj.insert("conversationCount".into(), json!(self.conversation_count));
        if self.include_request_count {
            obj.insert("requestCount".into(), json!(self.request_count));
        }
        obj.insert("inputTokens".into(), json!(self.bucket.input_tokens));
        obj.insert("outputTokens".into(), json!(self.bucket.output_tokens));
        obj.insert(
            "cacheReadTokens".into(),
            json!(self.bucket.cache_read_tokens),
        );
        obj.insert(
            "cacheWriteTokens".into(),
            json!(self.bucket.cache_write_tokens),
        );
        obj.insert("totalTokens".into(), json!(self.bucket.total_tokens));
        obj.insert(
            "estimatedCostUsd".into(),
            if self.has_pricing {
                json!(self.estimated_cost_usd)
            } else {
                Value::Null
            },
        );
        obj.insert("hasPricing".into(), json!(self.has_pricing));
        Value::Object(obj)
    }
}

fn sort_group_rows(mut rows: Vec<GroupRow>) -> Vec<Value> {
    rows.sort_by(|a, b| {
        let ca = if a.has_pricing {
            a.estimated_cost_usd
        } else {
            -1.0
        };
        let cb = if b.has_pricing {
            b.estimated_cost_usd
        } else {
            -1.0
        };
        cb.partial_cmp(&ca)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                b.bucket
                    .total_tokens
                    .partial_cmp(&a.bucket.total_tokens)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| a.label.cmp(&b.label))
    });
    rows.into_iter().map(|r| r.to_json()).collect()
}

pub fn collect_usage_stats(data_home: &Path, generated_at: Option<&str>) -> Value {
    let providers = load_flattened_providers(data_home);
    let provider_index = ProviderIndex::from_providers(&providers);
    let requests = read_usage_request_tail(data_home, MAX_READ_LIMIT);
    let generated_at = generated_at.map(str::to_owned).unwrap_or_else(|| {
        OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_default()
    });

    if !requests.is_empty() {
        let mut totals = FullTokenBucket::default();
        let mut by_provider: HashMap<String, GroupRow> = HashMap::new();
        let mut by_model: HashMap<String, GroupRow> = HashMap::new();
        let mut by_role: HashMap<String, GroupRow> = HashMap::new();
        let mut estimated_cost_usd = 0.0;
        let mut has_any_pricing = false;
        let mut request_count = 0u64;

        for row in &requests {
            let bucket = FullTokenBucket::from_row(row);
            if bucket.is_zero_io() {
                continue;
            }
            request_count += 1;
            totals.add(&bucket);

            let cost = finite_f64(&row["estimatedCostUsd"]);
            let priced = cost > 0.0 || !row["pricingSource"].is_null();

            let raw_mp_id = trimmed_str(&row["modelProviderId"])
                .unwrap_or_else(|| UNBOUND_PROVIDER_KEY.to_owned());
            let (comp_group, comp_model) = split_composite_provider_id(&raw_mp_id);
            let p_key = if let Some(written) =
                trimmed_str(&row["groupId"]).filter(|g| g != UNBOUND_PROVIDER_KEY)
            {
                written
            } else if !comp_group.is_empty() {
                comp_group.clone()
            } else if raw_mp_id == UNBOUND_PROVIDER_KEY {
                raw_mp_id.clone()
            } else if comp_model.is_empty() {
                provider_index
                    .by_id
                    .get(&raw_mp_id)
                    .or_else(|| provider_index.by_group_id.get(&raw_mp_id))
                    .map(provider_group_key)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| raw_mp_id.clone())
            } else {
                raw_mp_id.clone()
            };

            let row_provider_name = trimmed_str(&row["providerName"]);
            let display_model = {
                let recorded = trimmed_str(&row["model"])
                    .or_else(|| row_provider_name.clone())
                    .unwrap_or_else(|| raw_mp_id.clone());
                if raw_mp_id == UNBOUND_PROVIDER_KEY {
                    recorded
                } else {
                    provider_index
                        .by_id
                        .get(&raw_mp_id)
                        .or_else(|| provider_index.by_composite.get(&raw_mp_id))
                        .map(provider_model_label)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(recorded)
                }
            };

            let p_entry = by_provider
                .entry(p_key.clone())
                .or_insert_with(|| GroupRow {
                    key: p_key.clone(),
                    label: row_provider_name.clone().unwrap_or_else(|| p_key.clone()),
                    provider_id: (p_key != UNBOUND_PROVIDER_KEY).then(|| p_key.clone()),
                    provider_name: row_provider_name.clone(),
                    model: None,
                    include_provider_fields: true,
                    include_model: false,
                    include_request_count: true,
                    conversation_count: 0,
                    request_count: 0,
                    bucket: FullTokenBucket::default(),
                    estimated_cost_usd: 0.0,
                    has_pricing: false,
                });
            p_entry.conversation_count += 1;
            p_entry.request_count += 1;
            p_entry.bucket.add(&bucket);
            if priced {
                p_entry.has_pricing = true;
                p_entry.estimated_cost_usd += cost;
            }

            let m_entry = by_model
                .entry(raw_mp_id.clone())
                .or_insert_with(|| GroupRow {
                    key: raw_mp_id.clone(),
                    label: display_model.clone(),
                    provider_id: (p_key != UNBOUND_PROVIDER_KEY).then(|| p_key.clone()),
                    provider_name: row_provider_name.clone(),
                    model: Some(display_model.clone()),
                    include_provider_fields: true,
                    include_model: true,
                    include_request_count: true,
                    conversation_count: 0,
                    request_count: 0,
                    bucket: FullTokenBucket::default(),
                    estimated_cost_usd: 0.0,
                    has_pricing: false,
                });
            m_entry.conversation_count += 1;
            m_entry.request_count += 1;
            m_entry.bucket.add(&bucket);
            if display_model != raw_mp_id {
                m_entry.label = display_model.clone();
                m_entry.model = Some(display_model.clone());
            }
            if priced {
                m_entry.has_pricing = true;
                m_entry.estimated_cost_usd += cost;
            }

            let r_key = trimmed_str(&row["role"]).unwrap_or_else(|| "unknown".to_owned());
            let r_entry = by_role.entry(r_key.clone()).or_insert_with(|| GroupRow {
                key: r_key.clone(),
                label: r_key,
                provider_id: None,
                provider_name: None,
                model: None,
                include_provider_fields: false,
                include_model: false,
                include_request_count: true,
                conversation_count: 0,
                request_count: 0,
                bucket: FullTokenBucket::default(),
                estimated_cost_usd: 0.0,
                has_pricing: false,
            });
            r_entry.conversation_count += 1;
            r_entry.request_count += 1;
            r_entry.bucket.add(&bucket);
            if priced {
                r_entry.has_pricing = true;
                r_entry.estimated_cost_usd += cost;
            }

            if priced {
                has_any_pricing = true;
                estimated_cost_usd += cost;
            }
        }

        return json!({
            "generatedAt": generated_at,
            "totals": {
                "inputTokens": totals.input_tokens,
                "outputTokens": totals.output_tokens,
                "cacheReadTokens": totals.cache_read_tokens,
                "cacheWriteTokens": totals.cache_write_tokens,
                "totalTokens": totals.total_tokens,
                "conversationCount": request_count,
                "pricedConversationCount": if has_any_pricing { request_count } else { 0 },
                "estimatedCostUsd": if has_any_pricing { json!(estimated_cost_usd) } else { Value::Null },
            },
            "byProvider": sort_group_rows(by_provider.into_values().collect()),
            "byModel": sort_group_rows(by_model.into_values().collect()),
            "byRole": sort_group_rows(by_role.into_values().collect()),
            "notes": {
                "unpricedConversationCount": 0,
                "missingProviderCount": 0,
                "pricingUnit": "USD_per_1M_tokens",
                "scope": "request_snapshot",
                "requestCount": request_count,
            },
        });
    }

    // Fallback path: lifetimeUsage across default-role conversations.
    let conversations = ConversationStore::new(data_home)
        .list_conversations_view(&ConversationListQuery {
            include_message_count: false,
            ..Default::default()
        })
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();

    let mut totals = FullTokenBucket::default();
    let mut conversation_count = 0u64;
    let mut priced_conversation_count = 0u64;
    let mut unpriced_conversation_count = 0u64;
    let mut missing_provider_count = 0u64;
    let mut estimated_cost_usd = 0.0;
    let mut has_any_pricing = false;
    let mut by_provider: HashMap<String, GroupRow> = HashMap::new();
    let mut by_model: HashMap<String, GroupRow> = HashMap::new();

    for meta in &conversations {
        let usage = FullTokenBucket::from_row(&meta["lifetimeUsage"]);
        conversation_count += 1;
        totals.add(&usage);

        let mp_id = trimmed_str(&meta["modelProviderId"]).unwrap_or_default();
        let (comp_group, comp_model) = split_composite_provider_id(&mp_id);
        let resolved_provider = if mp_id.is_empty() {
            None
        } else {
            provider_index
                .by_id
                .get(&mp_id)
                .or_else(|| provider_index.by_composite.get(&mp_id))
                .cloned()
                .or_else(|| {
                    if !comp_group.is_empty() {
                        provider_index
                            .by_group_id
                            .get(&comp_group)
                            .or_else(|| provider_index.by_id.get(&comp_group))
                            .cloned()
                    } else {
                        provider_index.by_group_id.get(&mp_id).cloned()
                    }
                })
        };

        if mp_id.is_empty() || resolved_provider.is_none() {
            missing_provider_count += 1;
        }

        let (group_key, group_label, model_id, model_display, pricing_provider) =
            if mp_id.is_empty() {
                (
                    UNBOUND_PROVIDER_KEY.to_owned(),
                    UNBOUND_PROVIDER_LABEL.to_owned(),
                    UNBOUND_MODEL_LABEL.to_owned(),
                    UNBOUND_MODEL_LABEL.to_owned(),
                    None,
                )
            } else {
                let gk = resolved_provider
                    .as_ref()
                    .map(provider_group_key)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| {
                        if !comp_group.is_empty() {
                            comp_group.clone()
                        } else {
                            mp_id.clone()
                        }
                    });
                let gl = resolved_provider
                    .as_ref()
                    .and_then(|p| trimmed_str(&p["name"]))
                    .or_else(|| {
                        provider_index
                            .by_group_id
                            .get(&gk)
                            .and_then(|p| trimmed_str(&p["name"]))
                    })
                    .unwrap_or_else(|| gk.clone());
                let meta_model = trimmed_str(&meta["model"]).unwrap_or_default();
                let prov_model = resolved_provider
                    .as_ref()
                    .and_then(|p| trimmed_str(&p["model"]))
                    .unwrap_or_default();
                let mid = if !meta_model.is_empty() {
                    meta_model.clone()
                } else if !comp_model.is_empty() {
                    comp_model.clone()
                } else if !prov_model.is_empty() {
                    prov_model.clone()
                } else {
                    mp_id.clone()
                };
                let exact_model_provider = provider_index
                    .by_composite
                    .get(&format!("{gk}::{mid}"))
                    .cloned();
                let label_provider = exact_model_provider
                    .as_ref()
                    .filter(|p| trimmed_str(&p["model"]).as_deref() == Some(mid.as_str()))
                    .or_else(|| resolved_provider.as_ref().filter(|_| prov_model == mid));
                let m_disp = label_provider
                    .map(provider_model_label)
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        exact_model_provider
                            .as_ref()
                            .map(provider_model_label)
                            .filter(|s| !s.is_empty())
                    })
                    .or_else(|| (!meta_model.is_empty()).then_some(meta_model))
                    .or_else(|| (!comp_model.is_empty()).then_some(comp_model))
                    .or_else(|| {
                        resolved_provider
                            .as_ref()
                            .map(provider_model_label)
                            .filter(|s| !s.is_empty())
                    })
                    .unwrap_or_else(|| mid.clone());
                let pricing_prov = exact_model_provider
                    .or_else(|| {
                        resolved_provider
                            .as_ref()
                            .filter(|_| prov_model == mid)
                            .cloned()
                    })
                    .or(resolved_provider);
                (gk, gl, mid, m_disp, pricing_prov)
            };

        let cost_opt = pricing_provider.as_ref().and_then(|p| {
            let ip = optional_f64(&p["inputPrice"]);
            let op = optional_f64(&p["outputPrice"]);
            let cr = optional_f64(&p["cacheReadPrice"]);
            let cw = optional_f64(&p["cacheWritePrice"]);
            if ip.is_none() && op.is_none() && cr.is_none() && cw.is_none() {
                return None;
            }
            let usd = (usage.input_tokens * ip.unwrap_or(0.0)
                + usage.output_tokens * op.unwrap_or(0.0)
                + usage.cache_read_tokens * cr.unwrap_or(0.0)
                + usage.cache_write_tokens * cw.unwrap_or(0.0))
                / TOKENS_PER_MILLION;
            Some(usd)
        });

        if let Some(usd) = cost_opt {
            priced_conversation_count += 1;
            has_any_pricing = true;
            estimated_cost_usd += usd;
        } else {
            unpriced_conversation_count += 1;
        }

        let p_entry = by_provider
            .entry(group_key.clone())
            .or_insert_with(|| GroupRow {
                key: group_key.clone(),
                label: group_label.clone(),
                provider_id: (group_key != UNBOUND_PROVIDER_KEY).then(|| group_key.clone()),
                provider_name: Some(group_label.clone()),
                model: None,
                include_provider_fields: true,
                include_model: false,
                include_request_count: false,
                conversation_count: 0,
                request_count: 0,
                bucket: FullTokenBucket::default(),
                estimated_cost_usd: 0.0,
                has_pricing: false,
            });
        p_entry.conversation_count += 1;
        p_entry.bucket.add(&usage);
        if let Some(usd) = cost_opt {
            p_entry.has_pricing = true;
            p_entry.estimated_cost_usd += usd;
        }

        let m_key = format!("{group_key}::{model_id}");
        let m_entry = by_model.entry(m_key.clone()).or_insert_with(|| GroupRow {
            key: m_key.clone(),
            label: model_display.clone(),
            provider_id: (group_key != UNBOUND_PROVIDER_KEY).then(|| group_key.clone()),
            provider_name: Some(group_label.clone()),
            model: Some(model_display.clone()),
            include_provider_fields: true,
            include_model: true,
            include_request_count: false,
            conversation_count: 0,
            request_count: 0,
            bucket: FullTokenBucket::default(),
            estimated_cost_usd: 0.0,
            has_pricing: false,
        });
        m_entry.conversation_count += 1;
        m_entry.bucket.add(&usage);
        if model_display != m_key && model_display != model_id {
            m_entry.label = model_display.clone();
            m_entry.model = Some(model_display);
        }
        if let Some(usd) = cost_opt {
            m_entry.has_pricing = true;
            m_entry.estimated_cost_usd += usd;
        }
    }

    json!({
        "generatedAt": generated_at,
        "totals": {
            "inputTokens": totals.input_tokens,
            "outputTokens": totals.output_tokens,
            "cacheReadTokens": totals.cache_read_tokens,
            "cacheWriteTokens": totals.cache_write_tokens,
            "totalTokens": totals.total_tokens,
            "conversationCount": conversation_count,
            "pricedConversationCount": priced_conversation_count,
            "estimatedCostUsd": if has_any_pricing { json!(estimated_cost_usd) } else { Value::Null },
        },
        "byProvider": sort_group_rows(by_provider.into_values().collect()),
        "byModel": sort_group_rows(by_model.into_values().collect()),
        "byRole": [],
        "notes": {
            "unpricedConversationCount": unpriced_conversation_count,
            "missingProviderCount": missing_provider_count,
            "pricingUnit": "USD_per_1M_tokens",
            "scope": "conversation_lifetime_usage",
        },
    })
}

pub fn collect_usage_daily(
    data_home: &Path,
    range: Option<&str>,
    now: Option<&str>,
    local_offset_minutes: i32,
) -> Value {
    let rows = read_usage_request_tail(data_home, MAX_READ_LIMIT);
    let resolved_range = match range {
        Some("7d" | "1m" | "3m" | "6m" | "1y") => range.unwrap(),
        _ => "1m",
    };
    let span_days: i64 = match resolved_range {
        "7d" => 6,
        "1m" => 29,
        "3m" => 89,
        "6m" => 179,
        _ => 364,
    };
    let offset = parse_offset(local_offset_minutes);
    let end_dt = parse_now_or_utc(now);
    let end_date = end_dt.to_offset(offset).date();
    let start_date = end_date - Duration::days(span_days);

    #[derive(Default, Clone)]
    struct DayBucket {
        input: f64,
        output: f64,
        cache_read: f64,
        cache_write: f64,
        total: f64,
        requests: u64,
        cost: f64,
        has_cost: bool,
    }

    let mut days_map: BTreeMap<String, DayBucket> = BTreeMap::new();
    let mut cursor = start_date;
    while cursor <= end_date {
        days_map.insert(format_date_ymd(cursor), DayBucket::default());
        cursor += Duration::days(1);
    }

    let mut request_count = 0u64;
    let mut priced_request_count = 0u64;
    for row in &rows {
        let Some(date) = to_local_date(row["at"].as_str(), end_dt, offset) else {
            continue;
        };
        let key = format_date_ymd(date);
        let Some(bucket) = days_map.get_mut(&key) else {
            continue;
        };
        let inp = finite_f64(&row["inputTokens"]);
        let out = finite_f64(&row["outputTokens"]);
        let cr = finite_f64(&row["cacheReadTokens"]);
        let cw = finite_f64(&row["cacheWriteTokens"]);
        let tot = inp + out + cr + cw;
        let weight = finite_f64(&row["providerRequestCount"]).floor().max(1.0) as u64;

        bucket.input += inp;
        bucket.output += out;
        bucket.cache_read += cr;
        bucket.cache_write += cw;
        bucket.total += tot;
        bucket.requests += weight;
        request_count += weight;

        if let Some(cost) = optional_f64(&row["estimatedCostUsd"]) {
            bucket.cost += cost;
            bucket.has_cost = true;
            priced_request_count += weight;
        }
    }

    let mut max_tokens = 0.0f64;
    let mut total_tokens = 0.0f64;
    let mut total_cost = 0.0f64;
    let mut has_any_cost = false;
    let mut active_day_count = 0u64;

    let days: Vec<Value> = days_map
        .into_iter()
        .map(|(date, b)| {
            total_tokens += b.total;
            if b.total > max_tokens {
                max_tokens = b.total;
            }
            if b.total > 0.0 || b.requests > 0 {
                active_day_count += 1;
            }
            if b.has_cost {
                total_cost += b.cost;
                has_any_cost = true;
            }
            json!({
                "date": date,
                "inputTokens": b.input,
                "outputTokens": b.output,
                "cacheReadTokens": b.cache_read,
                "cacheWriteTokens": b.cache_write,
                "totalTokens": b.total,
                "requestCount": b.requests,
                "estimatedCostUsd": if b.has_cost { json!(b.cost) } else { Value::Null },
            })
        })
        .collect();

    json!({
        "range": resolved_range,
        "startDate": format_date_ymd(start_date),
        "endDate": format_date_ymd(end_date),
        "source": "request-log",
        "days": days,
        "totals": {
            "totalTokens": total_tokens,
            "requestCount": request_count,
            "pricedRequestCount": priced_request_count,
            "estimatedCostUsd": if has_any_cost { json!(total_cost) } else { Value::Null },
            "maxTokens": max_tokens,
            "dayCount": span_days + 1,
            "activeDayCount": active_day_count,
        },
        "notes": {
            "emptyLog": rows.is_empty(),
            "scope": "request-log-only",
        },
    })
}

pub fn collect_usage_day(
    data_home: &Path,
    date: Option<&str>,
    now: Option<&str>,
    local_offset_minutes: i32,
) -> Value {
    let rows = read_usage_request_tail(data_home, MAX_READ_LIMIT);
    let providers = load_flattened_providers(data_home);
    let mut label_index: HashMap<String, String> = HashMap::new();
    for p in &providers {
        if let Some(id) = trimmed_str(&p["id"]) {
            let label = trimmed_str(&p["modelLabel"])
                .or_else(|| trimmed_str(&p["model"]))
                .unwrap_or_else(|| id.clone());
            label_index.insert(id, label);
        }
    }

    let offset = parse_offset(local_offset_minutes);
    let fallback_dt = parse_now_or_utc(now);
    let target_date = date.and_then(parse_ymd).map(format_date_ymd);

    #[derive(Default, Clone)]
    struct DayModelBucket {
        key: String,
        label: String,
        model_provider_id: Option<String>,
        provider_name: Option<String>,
        input: f64,
        output: f64,
        cache_read: f64,
        cache_write: f64,
        total: f64,
        requests: u64,
        cost: f64,
        has_cost: bool,
    }

    #[derive(Default, Clone)]
    struct HourBucket {
        input: f64,
        output: f64,
        cache_read: f64,
        cache_write: f64,
        total: f64,
        requests: u64,
    }

    let mut by_model: HashMap<String, DayModelBucket> = HashMap::new();
    let mut hours = vec![HourBucket::default(); 24];
    let mut total_input = 0.0f64;
    let mut total_output = 0.0f64;
    let mut total_cr = 0.0f64;
    let mut total_cw = 0.0f64;
    let mut total_tokens = 0.0f64;
    let mut total_requests = 0u64;
    let mut priced_requests = 0u64;
    let mut total_cost = 0.0f64;
    let mut has_any_cost = false;

    if let Some(ref target) = target_date {
        for row in &rows {
            let Some(row_date) = to_local_date(row["at"].as_str(), fallback_dt, offset) else {
                continue;
            };
            if format_date_ymd(row_date) != *target {
                continue;
            }
            let inp = finite_f64(&row["inputTokens"]);
            let out = finite_f64(&row["outputTokens"]);
            let cr = finite_f64(&row["cacheReadTokens"]);
            let cw = finite_f64(&row["cacheWriteTokens"]);
            let tot = inp + out + cr + cw;
            let weight = finite_f64(&row["providerRequestCount"]).floor().max(1.0) as u64;
            let cost = optional_f64(&row["estimatedCostUsd"]);

            total_input += inp;
            total_output += out;
            total_cr += cr;
            total_cw += cw;
            total_tokens += tot;
            total_requests += weight;
            if let Some(c) = cost {
                priced_requests += weight;
                total_cost += c;
                has_any_cost = true;
            }

            let m_key =
                trimmed_str(&row["modelProviderId"]).unwrap_or_else(|| UNBOUND_PROVIDER_KEY.into());
            let entry = by_model.entry(m_key.clone()).or_insert_with(|| {
                let label = if m_key != UNBOUND_PROVIDER_KEY {
                    label_index.get(&m_key).cloned()
                } else {
                    None
                }
                .or_else(|| trimmed_str(&row["model"]))
                .or_else(|| trimmed_str(&row["providerName"]))
                .unwrap_or_else(|| m_key.clone());
                DayModelBucket {
                    key: m_key.clone(),
                    label,
                    model_provider_id: (m_key != UNBOUND_PROVIDER_KEY).then(|| m_key.clone()),
                    provider_name: trimmed_str(&row["providerName"]),
                    ..Default::default()
                }
            });
            entry.input += inp;
            entry.output += out;
            entry.cache_read += cr;
            entry.cache_write += cw;
            entry.total += tot;
            entry.requests += weight;
            if let Some(c) = cost {
                entry.has_cost = true;
                entry.cost += c;
            }

            let hour_idx = row["at"]
                .as_str()
                .and_then(|at| to_local_datetime(at, offset))
                .map(|dt| dt.hour() as usize)
                .unwrap_or(0)
                .min(23);
            let h = &mut hours[hour_idx];
            h.input += inp;
            h.output += out;
            h.cache_read += cr;
            h.cache_write += cw;
            h.total += tot;
            h.requests += weight;
        }
    }

    let mut model_rows: Vec<DayModelBucket> = by_model.into_values().collect();
    model_rows.sort_by(|a, b| {
        let ca = if a.has_cost { a.cost } else { -1.0 };
        let cb = if b.has_cost { b.cost } else { -1.0 };
        cb.partial_cmp(&ca)
            .unwrap_or(Ordering::Equal)
            .then_with(|| b.total.partial_cmp(&a.total).unwrap_or(Ordering::Equal))
            .then_with(|| a.label.cmp(&b.label))
    });

    let active_hour_count = hours
        .iter()
        .filter(|h| h.total > 0.0 || h.requests > 0)
        .count();
    let max_hour_tokens = hours.iter().map(|h| h.total).fold(0.0f64, f64::max);

    let model_list: Vec<Value> = model_rows
        .iter()
        .map(|b| {
            json!({
                "key": b.key,
                "label": b.label,
                "modelProviderId": b.model_provider_id,
                "providerName": b.provider_name,
                "inputTokens": b.input,
                "outputTokens": b.output,
                "cacheReadTokens": b.cache_read,
                "cacheWriteTokens": b.cache_write,
                "totalTokens": b.total,
                "requestCount": b.requests,
                "estimatedCostUsd": if b.has_cost { json!(b.cost) } else { Value::Null },
                "hasCost": b.has_cost,
            })
        })
        .collect();

    let hour_list: Vec<Value> = hours
        .into_iter()
        .enumerate()
        .map(|(hour, h)| {
            json!({
                "hour": hour,
                "inputTokens": h.input,
                "outputTokens": h.output,
                "cacheReadTokens": h.cache_read,
                "cacheWriteTokens": h.cache_write,
                "totalTokens": h.total,
                "requestCount": h.requests,
            })
        })
        .collect();

    let empty_day = target_date.is_none() || (total_tokens == 0.0 && total_requests == 0);

    json!({
        "date": target_date,
        "source": "request-log",
        "totals": {
            "inputTokens": total_input,
            "outputTokens": total_output,
            "cacheReadTokens": total_cr,
            "cacheWriteTokens": total_cw,
            "totalTokens": total_tokens,
            "requestCount": total_requests,
            "pricedRequestCount": priced_requests,
            "estimatedCostUsd": if has_any_cost { json!(total_cost) } else { Value::Null },
            "modelCount": model_list.len(),
            "activeHourCount": active_hour_count,
            "maxHourTokens": max_hour_tokens,
        },
        "byModel": model_list,
        "hours": hour_list,
        "notes": {
            "emptyDay": empty_day,
            "scope": "request-log-only",
        },
    })
}

#[derive(Default, Clone, Copy)]
struct CacheBucket {
    input_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
}

impl CacheBucket {
    fn from_row(row: &Value) -> Self {
        Self {
            input_tokens: finite_f64(&row["inputTokens"]),
            cache_read_tokens: finite_f64(&row["cacheReadTokens"]),
            cache_write_tokens: finite_f64(&row["cacheWriteTokens"]),
        }
    }

    fn add(&mut self, other: Self) {
        self.input_tokens += other.input_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
    }

    fn hit_rate(self) -> Option<f64> {
        let denom = self.cache_read_tokens + self.input_tokens;
        if denom <= 0.0 {
            None
        } else {
            Some(self.cache_read_tokens / denom)
        }
    }

    fn to_json(self) -> Value {
        json!({
            "inputTokens": self.input_tokens,
            "cacheReadTokens": self.cache_read_tokens,
            "cacheWriteTokens": self.cache_write_tokens,
        })
    }
}

fn is_no_cache_channel(row: &Value) -> bool {
    let provider_name = row["providerName"]
        .as_str()
        .map(peer_protocol::javascript_trim)
        .unwrap_or("");
    provider_name.is_empty() || provider_name.starts_with("zeus")
}

fn parse_epoch_ms(value: &Value) -> Option<i128> {
    let raw = value.as_str()?.trim();
    let dt = OffsetDateTime::parse(raw, &Rfc3339).ok()?;
    Some(dt.unix_timestamp_nanos() / 1_000_000)
}

pub fn collect_cache_hit_rate(data_home: &Path) -> Value {
    let rows = read_usage_request_tail(data_home, MAX_READ_LIMIT);

    let mut raw_bucket = CacheBucket::default();
    let mut raw_count = 0u64;
    let mut no_cache_bucket = CacheBucket::default();
    let mut no_cache_count = 0u64;

    struct ChannelRaw {
        provider_name: String,
        model: String,
        bucket: CacheBucket,
        count: u64,
    }
    let mut by_channel_raw: HashMap<String, ChannelRaw> = HashMap::new();
    let mut cacheable: Vec<&Value> = Vec::new();

    for row in &rows {
        let bucket = CacheBucket::from_row(row);
        raw_bucket.add(bucket);
        raw_count += 1;

        if is_no_cache_channel(row) {
            no_cache_bucket.add(bucket);
            no_cache_count += 1;
            continue;
        }
        cacheable.push(row);

        let prov_name = row["providerName"].as_str().unwrap_or("?").to_owned();
        let model = row["model"].as_str().unwrap_or("?").to_owned();
        let key = format!("{prov_name}/{model}");
        let entry = by_channel_raw.entry(key).or_insert_with(|| ChannelRaw {
            provider_name: prov_name,
            model,
            bucket: CacheBucket::default(),
            count: 0,
        });
        entry.bucket.add(bucket);
        entry.count += 1;
    }

    let mut by_conversation: HashMap<&str, Vec<&Value>> = HashMap::new();
    for row in cacheable {
        if let Some(cid) = row["conversationId"].as_str().filter(|s| !s.is_empty()) {
            by_conversation.entry(cid).or_default().push(row);
        }
    }

    let mut first_bucket = CacheBucket::default();
    let mut first_count = 0u64;
    let mut expired_bucket = CacheBucket::default();
    let mut expired_count = 0u64;
    let mut steady_bucket = CacheBucket::default();
    let mut steady_count = 0u64;
    let mut by_channel_steady: HashMap<String, (CacheBucket, u64)> = HashMap::new();

    for mut list in by_conversation.into_values() {
        list.sort_by(|a, b| {
            a["at"]
                .as_str()
                .unwrap_or("")
                .cmp(b["at"].as_str().unwrap_or(""))
        });
        for (i, row) in list.iter().enumerate() {
            let bucket = CacheBucket::from_row(row);
            if i == 0 {
                first_bucket.add(bucket);
                first_count += 1;
                continue;
            }
            let expired = match (
                parse_epoch_ms(&row["at"]),
                parse_epoch_ms(&list[i - 1]["at"]),
            ) {
                (Some(cur), Some(prev)) => (cur - prev) > STEADY_TTL_MS,
                _ => true,
            };
            if expired {
                expired_bucket.add(bucket);
                expired_count += 1;
            } else {
                steady_bucket.add(bucket);
                steady_count += 1;
                let prov_name = row["providerName"].as_str().unwrap_or("?");
                let model = row["model"].as_str().unwrap_or("?");
                let key = format!("{prov_name}/{model}");
                let entry = by_channel_steady
                    .entry(key)
                    .or_insert_with(|| (CacheBucket::default(), 0));
                entry.0.add(bucket);
                entry.1 += 1;
            }
        }
    }

    let mut by_channel_out: Vec<(f64, Value)> = by_channel_raw
        .into_iter()
        .map(|(key, ch)| {
            let steady_info = by_channel_steady.get(&key);
            let out = json!({
                "providerName": ch.provider_name,
                "model": ch.model,
                "count": ch.count,
                "inputTokens": ch.bucket.input_tokens,
                "cacheReadTokens": ch.bucket.cache_read_tokens,
                "rawHitRate": ch.bucket.hit_rate(),
                "steadyHitRate": steady_info.and_then(|(b, _)| b.hit_rate()),
                "steadyCount": steady_info.map(|(_, c)| *c).unwrap_or(0),
            });
            (ch.bucket.input_tokens, out)
        })
        .collect();
    by_channel_out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));
    let by_channel: Vec<Value> = by_channel_out.into_iter().map(|(_, v)| v).collect();

    let steady_json = json!({
        "count": steady_count,
        "bucket": steady_bucket.to_json(),
        "hitRate": steady_bucket.hit_rate(),
    });

    json!({
        "raw": {
            "count": raw_count,
            "bucket": raw_bucket.to_json(),
            "hitRate": raw_bucket.hit_rate(),
        },
        "steady": steady_json,
        "noCache": {
            "count": no_cache_count,
            "bucket": no_cache_bucket.to_json(),
            "hitRate": no_cache_bucket.hit_rate(),
        },
        "byForm": {
            "first": {
                "count": first_count,
                "bucket": first_bucket.to_json(),
                "hitRate": first_bucket.hit_rate(),
            },
            "expired": {
                "count": expired_count,
                "bucket": expired_bucket.to_json(),
                "hitRate": expired_bucket.hit_rate(),
            },
            "steady": steady_json,
        },
        "byChannel": by_channel,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn stats_daily_day_and_cache_hit_rate_aggregate_accurately() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        fs::create_dir_all(home.join("usage")).unwrap();
        fs::write(
            home.join("llm-providers.json"),
            serde_json::to_vec(&json!({
                "version": 2,
                "channels": [{ "id": "grp-1", "name": "OpenAI" }],
                "models": [{ "id": "m-1", "groupId": "grp-1", "model": "gpt-5", "modelLabel": "GPT 5" }]
            }))
            .unwrap(),
        )
        .unwrap();

        let rows = [
            json!({
                "id": "r1",
                "at": "2026-11-21T02:00:00Z",
                "conversationId": "c1",
                "modelProviderId": "m-1",
                "model": "gpt-5",
                "providerName": "OpenAI",
                "inputTokens": 1000,
                "outputTokens": 200,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "estimatedCostUsd": 0.01,
                "pricingSource": "manual",
                "role": "default"
            }),
            json!({
                "id": "r2",
                "at": "2026-11-21T02:02:00Z",
                "conversationId": "c1",
                "modelProviderId": "m-1",
                "model": "gpt-5",
                "providerName": "OpenAI",
                "inputTokens": 200,
                "outputTokens": 100,
                "cacheReadTokens": 800,
                "cacheWriteTokens": 0,
                "estimatedCostUsd": 0.005,
                "pricingSource": "manual",
                "role": "default"
            }),
            json!({
                "id": "pred-1",
                "requestPurpose": "input_prediction",
                "at": "2026-11-21T02:03:00Z",
                "conversationId": "c1",
                "modelProviderId": "m-1",
                "model": "gpt-5",
                "providerName": "OpenAI",
                "inputTokens": 50,
                "outputTokens": 10,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0
            }),
            json!({
                "id": "pred-1",
                "requestPurpose": "input_prediction",
                "at": "2026-11-21T02:03:05Z",
                "conversationId": "c1",
                "modelProviderId": "m-1",
                "model": "gpt-5",
                "providerName": "OpenAI",
                "inputTokens": 60,
                "outputTokens": 15,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0
            }),
        ];
        let body = rows
            .iter()
            .map(|r| serde_json::to_string(r).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(home.join("usage/requests.jsonl"), body).unwrap();

        let stats = collect_usage_stats(home, Some("2026-11-21T03:00:00Z"));
        assert_eq!(stats["notes"]["scope"], "request_snapshot");
        assert_eq!(stats["totals"]["conversationCount"], 3);
        assert_eq!(stats["totals"]["inputTokens"].as_f64().unwrap(), 1260.0);
        assert_eq!(stats["byModel"][0]["label"], "GPT 5");
        assert_eq!(stats["byProvider"][0]["key"], "grp-1");

        let daily = collect_usage_daily(home, Some("7d"), Some("2026-11-21T03:00:00Z"), 480);
        assert_eq!(daily["range"], "7d");
        assert_eq!(daily["totals"]["dayCount"], 7);
        assert_eq!(daily["totals"]["activeDayCount"], 1);

        let day = collect_usage_day(home, Some("2026-11-21"), Some("2026-11-21T03:00:00Z"), 480);
        assert_eq!(day["date"], "2026-11-21");
        assert_eq!(day["byModel"][0]["label"], "GPT 5");
        // 02:00 UTC + 08:00 (+480 min) = hour 10
        assert_eq!(day["hours"][10]["requestCount"], 3);

        let cache = collect_cache_hit_rate(home);
        assert_eq!(cache["byForm"]["first"]["count"], 1);
        assert_eq!(cache["byForm"]["steady"]["count"], 2);
        let expected_steady_rate = 800.0 / (800.0 + 260.0);
        assert!((cache["steady"]["hitRate"].as_f64().unwrap() - expected_steady_rate).abs() < 1e-9);
    }

    #[test]
    fn stats_falls_back_to_conversation_lifetime_usage_when_request_log_missing() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        fs::write(
            home.join("llm-providers.json"),
            serde_json::to_vec(&json!({
                "version": 2,
                "channels": [{ "id": "anth", "name": "Anthropic", "inputPrice": 3.0, "outputPrice": 15.0 }],
                "models": [{ "id": "anth::claude", "groupId": "anth", "model": "claude", "modelLabel": "Claude" }]
            }))
            .unwrap(),
        )
        .unwrap();
        let conv = ConversationStore::new(home)
            .create_classic_conversation(&json!({ "title": "t" }))
            .unwrap();
        ConversationStore::new(home)
            .update_model_effort_classic(
                conv["id"].as_str().unwrap(),
                None,
                Some(Some("anth::claude")),
                None,
            )
            .unwrap();
        ConversationStore::new(home)
            .add_usage_classic(
                conv["id"].as_str().unwrap(),
                &json!({ "inputTokens": 1_000_000, "outputTokens": 0 }),
            )
            .unwrap();

        let stats = collect_usage_stats(home, None);
        assert_eq!(stats["notes"]["scope"], "conversation_lifetime_usage");
        assert!((stats["totals"]["estimatedCostUsd"].as_f64().unwrap() - 3.0).abs() < 1e-9);
    }
}
