//! Frontmatter of a locally mounted SKILL.md. The body belongs to the
//! permission-checked Skill Provider, outside catalog projection.
use std::collections::HashMap;
use yaml_rust2::{Event, Yaml, YamlLoader, parser::Parser};

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_EVENTS: usize = 2048;
const MAX_DEPTH: usize = 16;
const MAX_EXPANSION: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillManifest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub when_to_use: String,
    pub version: String,
    pub data_level: String,
    pub allowed_tools: Vec<String>,
}

impl SkillManifest {
    /// The caller provides the delimited header. Parse failures may use
    /// the existing legacy simple key/value syntax. Budget failures cannot.
    pub fn from_header(header: &str, directory_name: &str) -> Result<Option<Self>, &'static str> {
        if header.len() > MAX_HEADER_BYTES {
            return Err("skill_header_limit");
        }
        let yaml = match validate_header(header) {
            Ok(()) => YamlLoader::load_from_str(header).ok(),
            Err(HeaderError::Syntax) => None,
            Err(HeaderError::Limit) => return Err("skill_header_limit"),
        };
        let fallback;
        let map = if let Some(yaml) = yaml.as_ref().and_then(|doc| doc.first()) {
            yaml
        } else {
            fallback = loose_frontmatter(header);
            &fallback
        };
        let description = map["description"].as_str().unwrap_or_default();
        if peer_protocol::javascript_trim(description).is_empty() {
            return Ok(None);
        }
        let id = string_or(&map["skillId"], directory_name);
        Ok(Some(Self {
            id: id.into(),
            name: string_or(&map["name"], id).into(),
            description: description.into(),
            when_to_use: map["whenToUse"]
                .as_str()
                .or_else(|| map["when-to-use"].as_str())
                .unwrap_or_default()
                .into(),
            version: string_or(&map["version"], "0.0.0").into(),
            data_level: string_or(&map["dataLevel"], "D1_internal").into(),
            allowed_tools: map["allowed-tools"]
                .as_vec()
                .into_iter()
                .flatten()
                .filter_map(|node| node.as_str().map(str::to_owned))
                .collect(),
        }))
    }
}
fn string_or<'a>(value: &'a Yaml, default: &'a str) -> &'a str {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
}

#[derive(Debug, PartialEq, Eq)]
enum HeaderError {
    Syntax,
    Limit,
}

/// The YAML loader expands known aliases into owned values. Check the expanded
/// weight before entering the loader, using the parser's unexpanded events.
fn validate_header(header: &str) -> Result<(), HeaderError> {
    let mut parser = Parser::new_from_str(header);
    let mut anchors = HashMap::new();
    let mut nodes = vec![(0, 0usize)];
    let mut document = false;
    for _ in 0..MAX_EVENTS {
        let (event, _) = parser.next_token().map_err(|_| HeaderError::Syntax)?;
        let (anchor, weight) = match event {
            Event::StreamEnd => return Ok(()),
            Event::DocumentStart if document => return Err(HeaderError::Limit),
            Event::DocumentStart => {
                document = true;
                continue;
            }
            Event::MappingStart(anchor, _) | Event::SequenceStart(anchor, _) => {
                if nodes.len() > MAX_DEPTH {
                    return Err(HeaderError::Limit);
                }
                nodes.push((anchor, 1));
                continue;
            }
            Event::MappingEnd | Event::SequenceEnd => nodes.pop().ok_or(HeaderError::Syntax)?,
            Event::Scalar(value, _, anchor, _) => (anchor, value.len() + 1),
            Event::Alias(anchor) => (0, *anchors.get(&anchor).ok_or(HeaderError::Limit)?),
            _ => continue,
        };
        if anchor != 0 {
            anchors.insert(anchor, weight);
        }
        let (_, count) = nodes.last_mut().ok_or(HeaderError::Syntax)?;
        *count = count
            .checked_add(weight)
            .filter(|weight| *weight <= MAX_EXPANSION)
            .ok_or(HeaderError::Limit)?;
    }
    Err(HeaderError::Limit)
}

fn loose_frontmatter(header: &str) -> Yaml {
    let mut entries = yaml_rust2::yaml::Hash::new();
    for line in header.lines().map(str::trim) {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        entries.insert(Yaml::String(key.into()), Yaml::String(value.into()));
    }
    Yaml::Hash(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mounted_headers_preserve_descriptions_defaults_and_scalar_aliases() {
        let selected = SkillManifest::from_header(
            "name: Native sample\ndescription: &summary |\n  Scoped fixture\nwhen-to-use: *summary\nallowed-tools: [local_shell_exec, read_file]",
            "sample",
        ).unwrap().unwrap();
        assert_eq!(selected.id, "sample");
        assert_eq!(selected.description, "Scoped fixture\n");
        assert_eq!(selected.when_to_use, selected.description);
        assert_eq!(selected.allowed_tools, ["local_shell_exec", "read_file"]);
        assert_eq!(selected.data_level, "D1_internal");
        let fallback =
            SkillManifest::from_header("description: Use local tools: example", "sample")
                .unwrap()
                .unwrap();
        assert_eq!(fallback.description, "Use local tools: example");
        assert!(
            SkillManifest::from_header("description: '  '", "sample")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn header_budgets_fail_before_the_loader_or_fallback() {
        let nested = format!(
            "description: Fixture\noptions: {}1{}",
            "[".repeat(32),
            "]".repeat(32)
        );
        assert_eq!(
            SkillManifest::from_header(&nested, "sample"),
            Err("skill_header_limit")
        );
        let large = "x".repeat(MAX_HEADER_BYTES + 1);
        assert_eq!(
            SkillManifest::from_header(&large, "sample"),
            Err("skill_header_limit")
        );
    }
}
