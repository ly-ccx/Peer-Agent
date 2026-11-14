//! Bounded root-field projection. Skipped values are syntax-checked without
//! constructing their AST; they remain source bytes, never Context instructions.
use super::{Budget, JsonLimits, Seed};
use serde::{
    Deserializer,
    de::{Error as _, IgnoredAny, MapAccess, Visitor},
};
use serde_json::{Map, Value};
use std::{
    cell::Cell,
    fmt,
    io::{self, BufReader, Read},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, Copy)]
pub struct ProjectionLimits {
    pub source_bytes: u64,
    pub selected: JsonLimits,
    pub key_bytes: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionError {
    InvalidJson,
    LimitExceeded,
    Cancelled,
    ReadFailed,
}
pub struct ProjectedJson {
    pub value: Value,
    pub source_bytes: u64,
    pub nodes: usize,
    pub string_bytes: usize,
}

struct Hooks {
    source: Cell<u64>,
    selected: Cell<usize>,
    selecting: Cell<bool>,
    key_left: Cell<Option<usize>>,
    failure: Cell<Option<ProjectionError>>,
}
struct CheckedReader<'a, R> {
    reader: BufReader<std::io::Take<R>>,
    hooks: &'a Hooks,
    limits: ProjectionLimits,
    cancelled: Option<&'a AtomicBool>,
    depth: usize,
    in_string: bool,
    escaped: bool,
    utf8_left: u8,
    utf8_min: u8,
    utf8_max: u8,
}
impl<R: Read> CheckedReader<'_, R> {
    fn failed(&self, kind: ProjectionError) -> io::Error {
        self.hooks.failure.set(Some(kind));
        io::Error::other("JSON projection admission failed")
    }
    fn byte(&mut self, byte: u8) -> io::Result<()> {
        // Validate skipped UTF-8 too; IgnoredAny does not decode those strings.
        if self.utf8_left > 0 {
            if !(self.utf8_min..=self.utf8_max).contains(&byte) {
                return Err(self.failed(ProjectionError::InvalidJson));
            }
            self.utf8_left -= 1;
            self.utf8_min = 0x80;
            self.utf8_max = 0xbf;
        } else if byte >= 0x80 {
            let (left, min, max) = match byte {
                0xc2..=0xdf => (1, 0x80, 0xbf),
                0xe0 => (2, 0xa0, 0xbf),
                0xe1..=0xec | 0xee..=0xef => (2, 0x80, 0xbf),
                0xed => (2, 0x80, 0x9f),
                0xf0 => (3, 0x90, 0xbf),
                0xf1..=0xf3 => (3, 0x80, 0xbf),
                0xf4 => (3, 0x80, 0x8f),
                _ => return Err(self.failed(ProjectionError::InvalidJson)),
            };
            self.utf8_left = left;
            self.utf8_min = min;
            self.utf8_max = max;
        }
        if self.in_string {
            if self.escaped {
                self.escaped = false;
            } else if byte == b'\\' {
                self.escaped = true;
            } else if byte == b'"' {
                self.in_string = false;
            }
        } else {
            match byte {
                b'"' => self.in_string = true,
                b'{' | b'[' => {
                    self.depth += 1;
                    if self.depth > self.limits.selected.depth + 1 {
                        return Err(self.failed(ProjectionError::LimitExceeded));
                    }
                }
                b'}' | b']' => {
                    self.depth = self
                        .depth
                        .checked_sub(1)
                        .ok_or_else(|| self.failed(ProjectionError::InvalidJson))?;
                }
                _ => {}
            }
        }
        Ok(())
    }
}
impl<R: Read> Read for CheckedReader<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
            return Err(self.failed(ProjectionError::Cancelled));
        }
        // Keep the phase gate outside the BufReader: read-ahead must not charge a
        // large skipped value to the preceding small map key.
        let count = self
            .reader
            .read(output)
            .map_err(|_| self.failed(ProjectionError::ReadFailed))?;
        if count == 0 && self.utf8_left > 0 {
            return Err(self.failed(ProjectionError::InvalidJson));
        }
        for byte in &output[..count] {
            let source = self.hooks.source.get().saturating_add(1);
            self.hooks.source.set(source);
            if source > self.limits.source_bytes {
                return Err(self.failed(ProjectionError::LimitExceeded));
            }
            if let Some(left) = self.hooks.key_left.get() {
                self.hooks
                    .key_left
                    .set(Some(left.checked_sub(1).ok_or_else(|| {
                        self.failed(ProjectionError::LimitExceeded)
                    })?));
            }
            if self.hooks.selecting.get() {
                let size = self.hooks.selected.get().saturating_add(1);
                self.hooks.selected.set(size);
                if size > self.limits.selected.bytes {
                    return Err(self.failed(ProjectionError::LimitExceeded));
                }
            }
            self.byte(*byte)?;
        }
        Ok(count)
    }
}

struct Root<'a, 'b> {
    fields: &'a [&'a str],
    hooks: &'b Hooks,
    budget: &'b mut Budget,
    key_bytes: usize,
}
impl<'de> Visitor<'de> for Root<'_, '_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a bounded JSON object projection")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut result = Map::new();
        loop {
            self.hooks.key_left.set(Some(self.key_bytes));
            let key = map.next_key::<String>();
            self.hooks.key_left.set(None);
            let Some(key) = key? else {
                break;
            };
            if self.fields.contains(&key.as_str()) {
                if key.len() > self.budget.remaining.string_bytes {
                    self.budget.exhausted = true;
                    return Err(A::Error::custom("selected key budget exhausted"));
                }
                self.budget.remaining.string_bytes -= key.len();
                self.budget.strings += key.len();
                self.hooks.selecting.set(true);
                let value = map.next_value_seed(Seed {
                    budget: self.budget,
                    depth: 1,
                });
                self.hooks.selecting.set(false);
                result.insert(key, value?);
            } else {
                let _: IgnoredAny = map.next_value()?;
            }
        }
        Ok(Value::Object(result))
    }
}

/// Selects at most 64 named root fields; no source mutation, role admission or
/// permission follows from parsing. key_bytes bounds each key decode unit
/// (including inter-field whitespace), selected.bytes bounds raw selected values.
pub fn project_json_reader(
    reader: impl Read,
    fields: &[&str],
    limits: ProjectionLimits,
    cancelled: Option<&AtomicBool>,
) -> Result<ProjectedJson, ProjectionError> {
    if fields.len() > 64
        || limits.key_bytes == 0
        || limits.key_bytes > 4096
        || fields.iter().any(|f| f.len() > limits.key_bytes)
        || limits.source_bytes == 0
        || limits.source_bytes > 1024 * 1024 * 1024
        || limits.selected.bytes > 64 * 1024 * 1024
        || limits.selected.nodes == 0
        || limits.selected.nodes > 65_536
        || limits.selected.depth > 64
        || limits.selected.string_bytes > 64 * 1024 * 1024
    {
        return Err(ProjectionError::LimitExceeded);
    }
    let hooks = Hooks {
        source: Cell::new(0),
        selected: Cell::new(0),
        selecting: Cell::new(false),
        key_left: Cell::new(None),
        failure: Cell::new(None),
    };
    let reader = CheckedReader {
        reader: BufReader::with_capacity(16 * 1024, reader.take(limits.source_bytes + 1)),
        hooks: &hooks,
        limits,
        cancelled,
        depth: 0,
        in_string: false,
        escaped: false,
        utf8_left: 0,
        utf8_min: 0x80,
        utf8_max: 0xbf,
    };
    let mut budget = Budget {
        remaining: limits.selected,
        exhausted: false,
        nodes: 1,
        strings: 0,
    };
    budget.remaining.nodes -= 1;
    let mut parser = serde_json::Deserializer::from_reader(reader);
    let value = parser.deserialize_map(Root {
        fields,
        hooks: &hooks,
        budget: &mut budget,
        key_bytes: limits.key_bytes,
    });
    let value = value
        .and_then(|value| {
            parser.end()?;
            Ok(value)
        })
        .map_err(|_| {
            hooks.failure.get().unwrap_or(if budget.exhausted {
                ProjectionError::LimitExceeded
            } else {
                ProjectionError::InvalidJson
            })
        })?;
    Ok(ProjectedJson {
        value,
        source_bytes: hooks.source.get(),
        nodes: budget.nodes,
        string_bytes: budget.strings,
    })
}
