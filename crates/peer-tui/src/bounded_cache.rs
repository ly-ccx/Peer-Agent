//! Strict byte-budgeted LRU cache and reading-anchor state (ADR 130).
//!
//! Keys must be compact stable identities (e.g. `(message_id_hash, revision, width)`),
//! never full message bodies. Eviction enforces both entry count and explicit byte budget.

use std::{
    collections::{HashMap, VecDeque},
    hash::Hash,
};

/// ADR 130 default budgets.
pub const DISPLAY_PAGE_CACHE_BYTES: usize = 16 * 1024 * 1024;
pub const MARKDOWN_WRAP_CACHE_BYTES: usize = 32 * 1024 * 1024;
pub const STREAMING_BUFFER_BYTES: usize = 8 * 1024 * 1024;

pub trait ByteSized {
    fn approx_bytes(&self) -> usize;
}

impl ByteSized for String {
    fn approx_bytes(&self) -> usize {
        self.capacity().max(self.len()) + std::mem::size_of::<String>()
    }
}

impl<T: ByteSized> ByteSized for Vec<T> {
    fn approx_bytes(&self) -> usize {
        std::mem::size_of::<Vec<T>>()
            + self.capacity() * std::mem::size_of::<T>()
            + self.iter().map(ByteSized::approx_bytes).sum::<usize>()
    }
}

struct Entry<V> {
    value: V,
    bytes: usize,
    generation: u64,
}

/// Deterministic byte-budgeted LRU cache with O(1) amortized lookups and strict eviction.
pub struct ByteBudgetLru<K, V> {
    max_bytes: usize,
    max_entries: usize,
    used_bytes: usize,
    clock: u64,
    map: HashMap<K, Entry<V>>,
    order: VecDeque<(K, u64)>,
}

impl<K: Eq + Hash + Clone, V: ByteSized> ByteBudgetLru<K, V> {
    pub fn new(max_bytes: usize, max_entries: usize) -> Self {
        Self {
            max_bytes: max_bytes.max(1024),
            max_entries: max_entries.max(1),
            used_bytes: 0,
            clock: 0,
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn used_bytes(&self) -> usize {
        self.used_bytes
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
        self.used_bytes = 0;
    }

    pub fn get(&mut self, key: &K) -> Option<&V> {
        {
            let entry = self.map.get_mut(key)?;
            self.clock = self.clock.wrapping_add(1);
            entry.generation = self.clock;
            self.order.push_back((key.clone(), self.clock));
        }
        self.compact_order_if_needed();
        self.map.get(key).map(|e| &e.value)
    }

    pub fn insert(&mut self, key: K, value: V) {
        let bytes = value
            .approx_bytes()
            .saturating_add(std::mem::size_of::<K>());
        // Single item larger than the entire budget is not cached (prevents thrashing all entries).
        if bytes > self.max_bytes {
            self.remove(&key);
            return;
        }
        if let Some(old) = self.map.remove(&key) {
            self.used_bytes = self.used_bytes.saturating_sub(old.bytes);
        }
        self.clock = self.clock.wrapping_add(1);
        let stamp = self.clock;
        self.map.insert(
            key.clone(),
            Entry {
                value,
                bytes,
                generation: stamp,
            },
        );
        self.order.push_back((key, stamp));
        self.used_bytes = self.used_bytes.saturating_add(bytes);
        self.evict();
    }

    pub fn remove(&mut self, key: &K) -> Option<V> {
        let old = self.map.remove(key)?;
        self.used_bytes = self.used_bytes.saturating_sub(old.bytes);
        Some(old.value)
    }

    /// Evict oldest entries down to at most `target_bytes` (e.g., on memory pressure).
    pub fn shrink_to_bytes(&mut self, target_bytes: usize) {
        while self.used_bytes > target_bytes {
            let Some((k, stamp)) = self.order.pop_front() else {
                break;
            };
            if self.map.get(&k).is_some_and(|e| e.generation == stamp)
                && let Some(old) = self.map.remove(&k)
            {
                self.used_bytes = self.used_bytes.saturating_sub(old.bytes);
            }
        }
    }

    fn evict(&mut self) {
        while self.used_bytes > self.max_bytes || self.map.len() > self.max_entries {
            let Some((k, stamp)) = self.order.pop_front() else {
                break;
            };
            if self.map.get(&k).is_some_and(|e| e.generation == stamp)
                && let Some(old) = self.map.remove(&k)
            {
                self.used_bytes = self.used_bytes.saturating_sub(old.bytes);
            }
        }
        self.compact_order_if_needed();
    }

    fn compact_order_if_needed(&mut self) {
        if self.order.len() > self.map.len().saturating_mul(4).saturating_add(64) {
            let mut live = VecDeque::with_capacity(self.map.len());
            for (k, stamp) in self.order.drain(..) {
                if self.map.get(&k).is_some_and(|e| e.generation == stamp) {
                    live.push_back((k, stamp));
                }
            }
            self.order = live;
        }
    }
}

/// Viewport reading intent (Peer Human-Agent Interaction Contract §4.1).
///
/// Once the user scrolls up or locates history, incoming streaming deltas NEVER
/// auto-hijack the viewport back to the bottom; only an explicit `jump_to_latest`
/// or scrolling all the way down resumes `FollowingLatest`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ReadingAnchor {
    #[default]
    FollowingLatest,
    Anchored {
        /// Number of rendered lines above the bottom of the transcript at last observation.
        lines_from_bottom: usize,
        /// Optional stable message identity being read.
        message_id: Option<String>,
    },
}

impl ReadingAnchor {
    pub fn is_following(&self) -> bool {
        matches!(self, Self::FollowingLatest)
    }

    pub fn lines_back(&self) -> usize {
        match self {
            Self::FollowingLatest => 0,
            Self::Anchored {
                lines_from_bottom, ..
            } => *lines_from_bottom,
        }
    }

    pub fn scroll_up(&mut self, delta: usize, max_back: usize, anchor_msg: Option<String>) {
        if delta == 0 || max_back == 0 {
            return;
        }
        let next = self.lines_back().saturating_add(delta).min(max_back);
        if next > 0 {
            *self = Self::Anchored {
                lines_from_bottom: next,
                message_id: anchor_msg,
            };
        }
    }

    pub fn scroll_down(&mut self, delta: usize) {
        if delta == 0 {
            return;
        }
        if let Self::Anchored {
            lines_from_bottom,
            message_id,
        } = self
        {
            let next = lines_from_bottom.saturating_sub(delta);
            if next == 0 {
                *self = Self::FollowingLatest;
            } else {
                *self = Self::Anchored {
                    lines_from_bottom: next,
                    message_id: message_id.clone(),
                };
            }
        }
    }

    /// When new lines arrive at the bottom while the user is anchored in history,
    /// increase `lines_from_bottom` by `added_lines` so the visible slice stays steady.
    pub fn on_bottom_appended(&mut self, added_lines: usize) {
        if let Self::Anchored {
            lines_from_bottom, ..
        } = self
        {
            *lines_from_bottom = lines_from_bottom.saturating_add(added_lines);
        }
    }

    pub fn jump_to_latest(&mut self) {
        *self = Self::FollowingLatest;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_budget_lru_enforces_byte_and_entry_limits_and_evicts_oldest() {
        let mut cache: ByteBudgetLru<u64, String> = ByteBudgetLru::new(1024, 16);
        for i in 0..40u64 {
            cache.insert(i, "x".repeat(120));
            assert!(
                cache.used_bytes() <= 1024,
                "used {} exceeded 1024 at iter {i}",
                cache.used_bytes()
            );
        }
        assert!(cache.get(&0).is_none(), "oldest entry must be evicted");
        assert!(cache.get(&39).is_some(), "newest entry must remain");

        // Oversized single entry is rejected without wiping existing cache.
        let before = cache.len();
        cache.insert(999, "y".repeat(4096));
        assert!(cache.get(&999).is_none());
        assert_eq!(cache.len(), before);

        cache.shrink_to_bytes(256);
        assert!(cache.used_bytes() <= 256);
    }

    #[test]
    fn reading_anchor_never_hijacks_history_when_new_stream_lines_arrive() {
        let mut anchor = ReadingAnchor::FollowingLatest;
        assert!(anchor.is_following());
        anchor.on_bottom_appended(5);
        assert!(anchor.is_following());

        anchor.scroll_up(10, 50, Some("msg-12".into()));
        assert!(!anchor.is_following());
        assert_eq!(anchor.lines_back(), 10);

        // New streamed lines append at bottom -> reading position shifts back to keep view pinned.
        anchor.on_bottom_appended(4);
        assert!(!anchor.is_following());
        assert_eq!(anchor.lines_back(), 14);

        // Explicit jump returns to bottom.
        anchor.jump_to_latest();
        assert!(anchor.is_following());
        assert_eq!(anchor.lines_back(), 0);
    }
}
