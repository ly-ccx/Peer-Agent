use serde::de::{DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

#[derive(Debug, Clone, Copy)]
pub struct JsonLimits {
    pub bytes: usize,
    pub nodes: usize,
    pub depth: usize,
    pub string_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonDecodeError {
    LimitExceeded,
    InvalidJson,
}
pub struct DecodedJson {
    pub value: Value,
    pub nodes: usize,
    pub string_bytes: usize,
}
struct Budget {
    remaining: JsonLimits,
    exhausted: bool,
    nodes: usize,
    strings: usize,
}
struct Seed<'a> {
    budget: &'a mut Budget,
    depth: usize,
}

/// Admission happens while serde walks the input, before building an
/// unbounded Value tree. This is factual decoding, never Context admission.
pub fn decode_json_bounded(
    bytes: &[u8],
    limits: JsonLimits,
) -> Result<DecodedJson, JsonDecodeError> {
    if bytes.len() > limits.bytes
        || limits.depth > 64
        || limits.nodes > 65_536
        || limits.string_bytes > 64 * 1024 * 1024
    {
        return Err(JsonDecodeError::LimitExceeded);
    }
    let mut budget = Budget {
        remaining: limits,
        exhausted: false,
        nodes: 0,
        strings: 0,
    };
    let mut parser = serde_json::Deserializer::from_slice(bytes);
    let result = Seed {
        budget: &mut budget,
        depth: 0,
    }
    .deserialize(&mut parser);
    let value = result.map_err(|_| {
        if budget.exhausted {
            JsonDecodeError::LimitExceeded
        } else {
            JsonDecodeError::InvalidJson
        }
    })?;
    parser.end().map_err(|_| JsonDecodeError::InvalidJson)?;
    Ok(DecodedJson {
        value,
        nodes: budget.nodes,
        string_bytes: budget.strings,
    })
}

impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if self.depth > self.budget.remaining.depth || self.budget.remaining.nodes == 0 {
            self.budget.exhausted = true;
            return Err(D::Error::custom("JSON allocation budget exhausted"));
        }
        self.budget.remaining.nodes -= 1;
        self.budget.nodes += 1;
        deserializer.deserialize_any(self)
    }
}

impl Seed<'_> {
    fn charge_string<E: serde::de::Error>(&mut self, length: usize) -> Result<(), E> {
        if length > self.budget.remaining.string_bytes {
            self.budget.exhausted = true;
            return Err(E::custom("JSON string budget exhausted"));
        }
        self.budget.remaining.string_bytes -= length;
        self.budget.strings += length;
        Ok(())
    }
}

impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Value, E> {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("nonfinite JSON number"))
    }
    fn visit_str<E: serde::de::Error>(mut self, value: &str) -> Result<Value, E> {
        self.charge_string(value.len())?;
        Ok(Value::String(value.to_owned()))
    }
    fn visit_string<E: serde::de::Error>(mut self, value: String) -> Result<Value, E> {
        self.charge_string(value.len())?;
        Ok(Value::String(value))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(Seed {
            budget: self.budget,
            depth: self.depth + 1,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(mut self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            self.charge_string(key.len())?;
            let value = map.next_value_seed(Seed {
                budget: self.budget,
                depth: self.depth + 1,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn limits() -> JsonLimits {
        JsonLimits {
            bytes: 8192,
            nodes: 16,
            depth: 4,
            string_bytes: 128,
        }
    }
    #[test]
    fn preserves_json_values_unknown_fields_and_last_duplicate_key() {
        let body = br#"{"k":"first","k":"last","future":[null,true,1.25,"\u4e2d\n"]}"#;
        let result = decode_json_bounded(body, limits()).unwrap();
        assert_eq!(result.value, serde_json::from_slice::<Value>(body).unwrap());
        // Root + both duplicate values + array + its four elements.
        assert_eq!(result.nodes, 8);
        assert!(result.string_bytes > 0);
    }
    #[test]
    fn rejects_depth_node_string_and_wire_limits_during_admission() {
        for body in [
            b"[[[[[[]]]]]]".as_slice(),
            b"[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]".as_slice(),
        ] {
            assert!(matches!(
                decode_json_bounded(body, limits()),
                Err(JsonDecodeError::LimitExceeded)
            ));
        }
        let oversized = serde_json::to_vec(&"x".repeat(129)).unwrap();
        assert!(matches!(
            decode_json_bounded(&oversized, limits()),
            Err(JsonDecodeError::LimitExceeded)
        ));
        let mut small = limits();
        small.bytes = 1;
        assert!(matches!(
            decode_json_bounded(b"{}", small),
            Err(JsonDecodeError::LimitExceeded)
        ));
        assert!(matches!(
            decode_json_bounded(b"{} {}", limits()),
            Err(JsonDecodeError::InvalidJson)
        ));
    }
}
