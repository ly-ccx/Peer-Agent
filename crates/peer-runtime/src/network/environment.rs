use super::*;
use std::path::PathBuf;
use zeroize::Zeroizing;
pub(super) fn space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}
fn trim(s: &str) -> &str {
    s.trim_matches(space)
}
pub(super) struct Environment {
    values: BTreeMap<String, Zeroizing<String>>,
    pub extra_ca: Option<PathBuf>,
}
impl Environment {
    pub fn read() -> Result<Self, Error> {
        let mut values = BTreeMap::new();
        for key in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
            "PEER_EXTRA_CA_CERTS",
            "NODE_EXTRA_CA_CERTS",
        ] {
            match std::env::var(key) {
                Ok(value) => {
                    if value.len() > 16384 {
                        return Err(Error("network_environment_limit"));
                    }
                    values.insert(key.into(), Zeroizing::new(value));
                }
                Err(std::env::VarError::NotPresent) => {}
                Err(_) => return Err(Error("network_environment_invalid")),
            }
        }
        Ok(Self::from_values(values))
    }
    fn from_values(values: BTreeMap<String, Zeroizing<String>>) -> Self {
        let mut result = Self {
            values,
            extra_ca: None,
        };
        result.extra_ca = result
            .first(&["PEER_EXTRA_CA_CERTS", "NODE_EXTRA_CA_CERTS"])
            .map(PathBuf::from);
        result
    }
    fn first(&self, names: &[&str]) -> Option<&str> {
        names
            .iter()
            .filter_map(|key| self.values.get(*key))
            .map(|v| trim(v))
            .find(|v| !v.is_empty())
    }
    fn bypass(&self, url: &Url) -> bool {
        let host = url.host_str().unwrap_or("").to_lowercase();
        let port = url
            .port_or_known_default()
            .map(|p| p.to_string())
            .unwrap_or_default();
        self.first(&["NO_PROXY", "no_proxy"]).is_some_and(|raw| {
            raw.split(|c| c == ',' || space(c))
                .filter(|v| !v.is_empty())
                .any(|rule| {
                    let rule = rule.to_lowercase();
                    if rule == "*" {
                        return true;
                    }
                    let (target, required) = if let Some(end) = rule
                        .strip_prefix('[')
                        .and_then(|v| v.find(']').map(|i| i + 1))
                    {
                        let rest = &rule[end + 1..];
                        let required = rest
                            .strip_prefix(':')
                            .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()));
                        if rest.is_empty() || required.is_some() {
                            (&rule[1..end], required)
                        } else {
                            (rule.as_str(), None)
                        }
                    } else if let Some((a, b)) = rule
                        .rsplit_once(':')
                        .filter(|(_, b)| !b.is_empty() && b.bytes().all(|v| v.is_ascii_digit()))
                    {
                        (a, Some(b))
                    } else {
                        (rule.as_str(), None)
                    };
                    if required.is_some_and(|v| v != port) {
                        return false;
                    }
                    let suffix = target.starts_with('.') || target.starts_with("*.");
                    let target = target
                        .strip_prefix("*.")
                        .or_else(|| target.strip_prefix('.'))
                        .unwrap_or(target);
                    host == target || (suffix && host.ends_with(&format!(".{target}")))
                })
        })
    }
    pub fn select<'a>(
        &'a self,
        url: &Url,
        system: &'a BTreeMap<String, String>,
    ) -> Option<&'a str> {
        if self.bypass(url) {
            return None;
        }
        match url.scheme() {
            "http" => self
                .first(&["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"])
                .or_else(|| system.get("http").map(String::as_str)),
            "https" => self
                .first(&["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
                .or_else(|| system.get("https").map(String::as_str)),
            _ => self.first(&["ALL_PROXY", "all_proxy"]),
        }
    }
    pub fn needs_system(&self, url: &Url) -> bool {
        !self.bypass(url) && self.select(url, &BTreeMap::new()).is_none()
    }
    #[cfg(test)]
    pub fn fixture(values: &serde_json::Value) -> Self {
        Self::from_values(
            values
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), Zeroizing::new(v.as_str().unwrap().into())))
                .collect(),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routing_matches_actual_ts_including_exact_host_and_no_proxy_precedence() {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/network.json"
        ))
        .unwrap();
        for case in data["routes"].as_array().unwrap() {
            let environment = Environment::fixture(&case["environment"]);
            let system = serde_json::from_value(case["system"].clone()).unwrap();
            assert_eq!(
                environment.select(&Url::parse(case["url"].as_str().unwrap()).unwrap(), &system),
                case["expected"].as_str(),
                "{}",
                case["name"]
            );
            assert_eq!(
                environment.extra_ca.as_ref().map(|p| p.to_str().unwrap()),
                case["extraCa"].as_str()
            );
        }
    }
}
