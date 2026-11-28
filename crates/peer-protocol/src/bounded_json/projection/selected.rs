//! Nested field selection shares the same source/depth/UTF-8/cancellation guard.
//! Recursive task/status views never allocate skipped task text or checkpoints.
use super::{Budget, CheckedReader, Hooks, ProjectedJson, ProjectionError, ProjectionLimits, Seed};
use serde::{
    Deserializer,
    de::{DeserializeSeed, Error as _, IgnoredAny, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Value};
use std::{
    cell::Cell,
    fmt,
    io::{BufReader, Read},
    sync::atomic::AtomicBool,
};

pub enum JsonSelection<'a> {
    Full,
    Object(&'a [(&'a str, JsonSelection<'a>)]),
    Each(&'a JsonSelection<'a>),
}
struct Select<'a, 'b> {
    selection: &'a JsonSelection<'a>,
    hooks: &'b Hooks,
    budget: &'b mut Budget,
    depth: usize,
    key_bytes: usize,
}
impl Select<'_, '_> {
    fn node<E: serde::de::Error>(&mut self) -> Result<(), E> {
        if self.depth > self.budget.remaining.depth || self.budget.remaining.nodes == 0 {
            self.budget.exhausted = true;
            return Err(E::custom("selection node budget exhausted"));
        }
        self.budget.remaining.nodes -= 1;
        self.budget.nodes += 1;
        Ok(())
    }
}
impl<'de> DeserializeSeed<'de> for Select<'_, '_> {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        match self.selection {
            JsonSelection::Full => {
                self.hooks.selecting.set(true);
                let result = Seed {
                    budget: self.budget,
                    depth: self.depth,
                }
                .deserialize(d);
                self.hooks.selecting.set(false);
                result
            }
            JsonSelection::Object(fields) => {
                if fields.len() > 64 || fields.iter().any(|(key, _)| key.len() > self.key_bytes) {
                    self.budget.exhausted = true;
                    return Err(D::Error::custom("invalid selection"));
                }
                // Bound malformed scalar input before serde can allocate its string.
                self.hooks.selecting.set(true);
                d.deserialize_option(Optional(self))
            }
            JsonSelection::Each(_) => {
                self.hooks.selecting.set(true);
                d.deserialize_option(Optional(self))
            }
        }
    }
}
struct Optional<'a, 'b>(Select<'a, 'b>);
impl<'de> Visitor<'de> for Optional<'_, '_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a nullable selected container")
    }
    fn visit_none<E: serde::de::Error>(mut self) -> Result<Value, E> {
        self.0.node()?;
        self.0.hooks.selecting.set(false);
        Ok(Value::Null)
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
        self.visit_none()
    }
    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        match self.0.selection {
            JsonSelection::Object(_) => d.deserialize_map(Container(self.0)),
            JsonSelection::Each(_) => d.deserialize_seq(Container(self.0)),
            JsonSelection::Full => unreachable!(),
        }
    }
}
struct Container<'a, 'b>(Select<'a, 'b>);
impl<'de> Visitor<'de> for Container<'_, '_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a selected object or array")
    }
    fn visit_map<A: MapAccess<'de>>(mut self, mut map: A) -> Result<Value, A::Error> {
        self.0.node()?;
        self.0.hooks.selecting.set(false);
        let JsonSelection::Object(fields) = self.0.selection else {
            return Err(A::Error::custom("expected object selection"));
        };
        let mut out = Map::new();
        loop {
            self.0.hooks.key_left.set(Some(self.0.key_bytes));
            let key = map.next_key::<String>();
            self.0.hooks.key_left.set(None);
            let Some(key) = key? else { break };
            if let Some((_, selection)) = fields.iter().find(|(name, _)| *name == key) {
                if key.len() > self.0.budget.remaining.string_bytes {
                    self.0.budget.exhausted = true;
                    return Err(A::Error::custom("selection key budget exhausted"));
                }
                self.0.budget.remaining.string_bytes -= key.len();
                self.0.budget.strings += key.len();
                let value = map.next_value_seed(Select {
                    selection,
                    hooks: self.0.hooks,
                    budget: self.0.budget,
                    depth: self.0.depth + 1,
                    key_bytes: self.0.key_bytes,
                })?;
                out.insert(key, value);
            } else {
                let _: IgnoredAny = map.next_value()?;
            }
        }
        Ok(Value::Object(out))
    }
    fn visit_seq<A: SeqAccess<'de>>(mut self, mut seq: A) -> Result<Value, A::Error> {
        self.0.node()?;
        self.0.hooks.selecting.set(false);
        let JsonSelection::Each(selection) = self.0.selection else {
            return Err(A::Error::custom("expected array selection"));
        };
        let mut out = Vec::new();
        while let Some(value) = seq.next_element_seed(Select {
            selection,
            hooks: self.0.hooks,
            budget: self.0.budget,
            depth: self.0.depth + 1,
            key_bytes: self.0.key_bytes,
        })? {
            out.push(value)
        }
        Ok(Value::Array(out))
    }
}
pub fn project_json_selected_reader(
    reader: impl Read,
    selection: &JsonSelection<'_>,
    limits: ProjectionLimits,
    cancelled: Option<&AtomicBool>,
) -> Result<ProjectedJson, ProjectionError> {
    if !matches!(selection, JsonSelection::Object(_))
        || limits.key_bytes == 0
        || limits.key_bytes > 4096
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
        nodes: 0,
        strings: 0,
    };
    let mut parser = serde_json::Deserializer::from_reader(reader);
    let value = Select {
        selection,
        hooks: &hooks,
        budget: &mut budget,
        depth: 0,
        key_bytes: limits.key_bytes,
    }
    .deserialize(&mut parser)
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
    if !value.is_object() {
        return Err(ProjectionError::InvalidJson);
    }
    Ok(ProjectedJson {
        value,
        source_bytes: hooks.source.get(),
        nodes: budget.nodes,
        string_bytes: budget.strings,
    })
}
