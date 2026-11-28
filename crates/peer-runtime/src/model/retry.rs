//! ADR 30 same-provider replay. The host still owns the step and its authority.
use super::{ModelError, NativeModel};
use crate::CancellationToken;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex, Weak},
    time::Duration,
};
use time::{OffsetDateTime, format_description::well_known::Rfc2822};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::Instant,
};

pub const SAME_PROVIDER_RETRY_DELAYS_MS: [u64; 3] = [500, 1_500, 3_000];
const MAX_DELAY_MS: u64 = 15_000;
const RETRY_WINDOW: Duration = Duration::from_secs(60);
const MAX_RETRY_AFTER_MS: u64 = 600_000;

/// Reset provisional output from the previous attempt before emitting any more
/// deltas. Attempt numbers are one-based and refer to the upcoming request.
/// A cancellation or authority change can still prevent the scheduled attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelRetryNotice {
    pub attempt: u32,
    pub max_attempts: u32,
    pub delay_ms: u64,
    pub error_category: &'static str,
    pub provider_code: Option<&'static str>,
}

pub struct ModelRetry {
    pub notice: ModelRetryNotice,
    pub deadline: Instant,
    ready_at: Instant,
}

pub struct SameProviderRetryPolicy {
    delays_ms: Vec<u64>,
    retries: usize,
    deadline: Option<Instant>,
    jitter_percent: fn() -> i8,
}

impl Default for SameProviderRetryPolicy {
    fn default() -> Self {
        Self::with_delays_ms(SAME_PROVIDER_RETRY_DELAYS_MS.to_vec())
    }
}

impl SameProviderRetryPolicy {
    pub fn with_delays_ms(delays_ms: Vec<u64>) -> Self {
        Self::with_jitter(delays_ms, random_jitter)
    }

    pub fn with_jitter(mut delays_ms: Vec<u64>, jitter_percent: fn() -> i8) -> Self {
        delays_ms.truncate(SAME_PROVIDER_RETRY_DELAYS_MS.len());
        Self {
            delays_ms,
            retries: 0,
            deadline: None,
            jitter_percent,
        }
    }

    pub fn next_retry(&mut self, error: &ModelError) -> Option<ModelRetry> {
        if !error.is_transient_retryable() {
            return None;
        }
        let base = (*self.delays_ms.get(self.retries)?).min(MAX_DELAY_MS);
        let percent = 100_i16 + i16::from((self.jitter_percent)().clamp(-15, 15));
        let jittered = (base * percent as u64 / 100).min(MAX_DELAY_MS);
        let delay_ms = error.retry_after_ms.unwrap_or(jittered);
        if delay_ms > MAX_DELAY_MS {
            return None;
        }
        let now = Instant::now();
        let deadline = *self.deadline.get_or_insert(now + RETRY_WINDOW);
        let ready_at = now + Duration::from_millis(delay_ms);
        if ready_at >= deadline {
            return None;
        }
        self.retries += 1;
        Some(ModelRetry {
            notice: ModelRetryNotice {
                attempt: self.retries as u32 + 1,
                max_attempts: self.delays_ms.len() as u32 + 1,
                delay_ms,
                error_category: error.code,
                provider_code: error.provider_code,
            },
            deadline,
            ready_at,
        })
    }
}

fn random_jitter() -> i8 {
    let mut sample = [0; 1];
    if getrandom::fill(&mut sample).is_ok() {
        (sample[0] % 31) as i8 - 15
    } else {
        0
    }
}

type RetryGates = HashMap<(String, reqwest::Url), Weak<Semaphore>>;
static GATES: LazyLock<Mutex<RetryGates>> = LazyLock::new(Mutex::default);

impl NativeModel {
    /// Rate limit physical replays at the provider origin. Fresh inference
    /// requests bypass the gate. Hold the returned permit through the attempt.
    pub async fn wait_for_retry(
        &self,
        retry: &ModelRetry,
        cancel: &CancellationToken,
    ) -> Result<Option<OwnedSemaphorePermit>, ModelError> {
        let mut origin = self.endpoint.clone();
        origin.set_path("/");
        origin.set_query(None);
        let key = (self.provider.clone(), origin);
        let gate = {
            let mut gates = GATES
                .lock()
                .map_err(|_| ModelError::new("model_retry_gate_unavailable"))?;
            gates.retain(|_, gate| gate.strong_count() != 0);
            gates.get(&key).and_then(Weak::upgrade).unwrap_or_else(|| {
                let gate = Arc::new(Semaphore::new(2));
                gates.insert(key, Arc::downgrade(&gate));
                gate
            })
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(ModelError::new("CANCELLED")),
            _ = tokio::time::sleep_until(retry.deadline) => Ok(None),
            result = async {
                tokio::time::sleep_until(retry.ready_at).await;
                gate.acquire_owned().await
            } => result.map(Some).map_err(|_| ModelError::new("model_retry_gate_unavailable")),
        }
    }
}

pub(super) fn retry_after_ms(raw: &str, now: OffsetDateTime) -> Option<u64> {
    let raw = raw.trim();
    if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        return Some(
            raw.parse::<u64>()
                .unwrap_or(u64::MAX)
                .saturating_mul(1000)
                .min(MAX_RETRY_AFTER_MS),
        );
    }
    let at = parse_http_date(raw, now)?;
    Some(
        (at - now)
            .whole_milliseconds()
            .clamp(0, i128::from(MAX_RETRY_AFTER_MS)) as u64,
    )
}

fn parse_http_date(raw: &str, now: OffsetDateTime) -> Option<OffsetDateTime> {
    if raw.len() > 40 || !raw.is_ascii() {
        return None;
    }
    if let Some(date) = raw.strip_suffix(" GMT") {
        if date.len() == 25 {
            // IMF-fixdate
            if let Ok(at) = OffsetDateTime::parse(&format!("{date} +0000"), &Rfc2822) {
                return Some(at);
            }
        }
        // Obsolete RFC 850 form uses a rolling 50-year cutoff for its short year.
        let (weekday, fields) = date.split_once(", ")?;
        let (date, clock) = fields.split_once(' ')?;
        let mut fields = date.split('-');
        let (day, month, short_year) = (fields.next()?, fields.next()?, fields.next()?);
        if fields.next().is_some() || short_year.len() != 2 {
            return None;
        }
        let short_year = short_year.parse::<u8>().ok().filter(|year| *year < 100)?;
        let cutoff_year = now.year() + 50;
        let year = cutoff_year - (cutoff_year - i32::from(short_year)).rem_euclid(100);
        let weekday = weekday.get(..3)?;
        let parse = |year| {
            OffsetDateTime::parse(
                &format!("{weekday}, {day} {month} {year} {clock} +0000"),
                &Rfc2822,
            )
            .ok()
        };
        let at = parse(year)?;
        let recent = (at.month(), at.day(), at.time()) <= (now.month(), now.day(), now.time());
        return if year == cutoff_year && !recent {
            parse(year - 100)
        } else {
            Some(at)
        };
    }
    // Obsolete asctime form has no explicit timezone; HTTP defines it as UTC.
    let parts: Vec<_> = raw.split_ascii_whitespace().collect();
    let [weekday, month, day, clock, year] = parts.as_slice() else {
        return None;
    };
    OffsetDateTime::parse(
        &format!("{weekday}, {day} {month} {year} {clock} +0000"),
        &Rfc2822,
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_parses_seconds_and_http_date_and_bounds_extremes() {
        let now = time::Date::from_calendar_date(1994, time::Month::November, 6)
            .unwrap()
            .with_hms(8, 49, 57)
            .unwrap()
            .assume_utc();
        assert_eq!(retry_after_ms(" 3 ", now), Some(3000));
        assert_eq!(
            retry_after_ms("Sun, 06 Nov 1994 08:50:00 GMT", now),
            Some(3000)
        );
        assert_eq!(
            retry_after_ms("Sun, 06 Nov 1994 08:49:00 GMT", now),
            Some(0)
        );
        assert_eq!(
            retry_after_ms("999999999999999999999999999999999", now),
            Some(600_000)
        );
        assert_eq!(
            retry_after_ms("Sunday, 06-Nov-94 08:50:00 GMT", now),
            Some(3000)
        );
        assert_eq!(retry_after_ms("Sun Nov  6 08:50:00 1994", now), Some(3000));
        let current = OffsetDateTime::from_unix_timestamp(1_791_283_777).unwrap();
        assert_eq!(
            retry_after_ms("Sunday, 06-Nov-94 08:50:00 GMT", current),
            Some(0)
        );
        assert_eq!(retry_after_ms("tomorrow", now), None);
    }

    #[test]
    fn uses_bounded_jitter_and_declines_waits_above_budget() {
        let mut policy =
            SameProviderRetryPolicy::with_jitter(SAME_PROVIDER_RETRY_DELAYS_MS.to_vec(), || 15);
        let mut error = ModelError::http(503, b"");
        assert_eq!(policy.next_retry(&error).unwrap().notice.delay_ms, 575);
        error.retry_after_ms = Some(600_000);
        assert!(policy.next_retry(&error).is_none());
        error.retry_after_ms = Some(2000);
        let retry = policy.next_retry(&error).unwrap();
        assert_eq!(retry.notice.attempt, 3);
        assert_eq!(retry.notice.max_attempts, 4);
        assert_eq!(retry.notice.delay_ms, 2000);
        error.retry_after_ms = None;
        assert_eq!(policy.next_retry(&error).unwrap().notice.delay_ms, 3450);
        assert!(policy.next_retry(&error).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn retry_window_does_not_extend_on_later_errors() {
        let mut policy = SameProviderRetryPolicy::with_jitter(vec![1, 2, 3], || 0);
        let error = ModelError::http(503, b"");
        let first = policy.next_retry(&error).unwrap();
        tokio::time::advance(Duration::from_secs(30)).await;
        assert_eq!(policy.next_retry(&error).unwrap().deadline, first.deadline);
        tokio::time::advance(Duration::from_secs(31)).await;
        assert!(policy.next_retry(&error).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_replays_share_two_origin_slots_and_queue_cancels() {
        use super::super::{
            ModelConfig,
            wire::{GenerationOptions, Wire},
        };
        let make_model = |path| {
            NativeModel::new(
                ModelConfig {
                    endpoint: format!("http://127.0.0.1:9/{path}"),
                    model: "model".into(),
                    provider: "retry-gate-test".into(),
                    wire: Wire::Chat,
                    generation: GenerationOptions::default(),
                },
                None,
                Duration::from_secs(60),
            )
            .unwrap()
        };
        let first = make_model("a");
        let second = make_model("b");
        let mut policy = SameProviderRetryPolicy::with_jitter(vec![0], || 0);
        let retry = policy.next_retry(&ModelError::http(503, b"")).unwrap();
        let cancel = CancellationToken::new();
        let first_permit = first
            .wait_for_retry(&retry, &cancel)
            .await
            .unwrap()
            .unwrap();
        let second_permit = second
            .wait_for_retry(&retry, &cancel)
            .await
            .unwrap()
            .unwrap();

        let waiting = second.wait_for_retry(&retry, &cancel);
        tokio::pin!(waiting);
        tokio::select! {
            biased;
            _ = &mut waiting => panic!("third replay bypassed the origin gate"),
            _ = tokio::time::sleep(Duration::from_millis(1)) => {},
        }
        cancel.cancel();
        assert!(waiting.await.is_err_and(|error| error.code == "CANCELLED"));

        let cancel = CancellationToken::new();
        let waiting = first.wait_for_retry(&retry, &cancel);
        tokio::pin!(waiting);
        tokio::select! {
            biased;
            _ = &mut waiting => panic!("third replay bypassed the origin gate"),
            _ = tokio::time::sleep(Duration::from_millis(1)) => {},
        }
        drop(first_permit);
        let replacement = waiting.await.unwrap().unwrap();
        assert!(
            second
                .wait_for_retry(&retry, &cancel)
                .await
                .unwrap()
                .is_none()
        );
        drop((second_permit, replacement));
    }
}
