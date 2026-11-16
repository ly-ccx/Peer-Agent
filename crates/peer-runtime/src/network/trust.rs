use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha1::{Digest, Sha1};
#[cfg(any(target_os = "macos", test))]
use std::collections::BTreeSet;
use std::{io::Read, path::Path};
const START: &str = "-----BEGIN CERTIFICATE-----";
const END: &str = "-----END CERTIFICATE-----";
pub(super) fn certificates(
    raw: &str,
    strict: bool,
) -> Result<Vec<(String, String, Certificate)>, Error> {
    let mut values = vec![];
    let mut remaining = raw;
    let mut count = 0;
    while let Some(start) = remaining.find(START) {
        count += 1;
        if count > 256 {
            return Err(Error("network_ca_limit"));
        }
        let content = &remaining[start + START.len()..];
        let Some(end) = content.find(END) else {
            if strict {
                return Err(Error("network_ca_invalid"));
            }
            break;
        };
        let pem = format!(
            "{}\n",
            &remaining[start..start + START.len() + end + END.len()]
        );
        remaining = &content[end + END.len()..];
        let text: String = content[..end]
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect();
        let parse = || {
            let der = STANDARD
                .decode(&text)
                .map_err(|_| Error("network_ca_invalid"))?;
            rustls::RootCertStore::empty()
                .add(rustls::pki_types::CertificateDer::from(der.clone()))
                .map_err(|_| Error("network_ca_invalid"))?;
            let fingerprint = format!("{:X}", Sha1::digest(&der));
            Ok((
                fingerprint,
                pem,
                Certificate::from_der(&der).map_err(|_| Error("network_ca_invalid"))?,
            ))
        };
        match parse() {
            Ok(value) => values.push(value),
            Err(error) if strict => return Err(error),
            Err(_) => {}
        }
    }
    if strict && values.is_empty() && !raw.trim().is_empty() {
        return Err(Error("network_ca_invalid"));
    }
    Ok(values)
}
pub(super) fn read_extra(path: &Path) -> Result<Vec<Certificate>, Error> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }
    let file = options
        .open(path)
        .map_err(|_| Error("network_ca_unavailable"))?;
    if !file
        .metadata()
        .map_err(|_| Error("network_ca_unavailable"))?
        .is_file()
    {
        return Err(Error("network_ca_invalid"));
    }
    let mut bytes = vec![];
    file.take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|_| Error("network_ca_unavailable"))?;
    if bytes.len() > 1_048_576 {
        return Err(Error("network_ca_limit"));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| Error("network_ca_invalid"))?;
    Ok(certificates(text, true)?
        .into_iter()
        .map(|(_, _, cert)| cert)
        .collect())
}
#[cfg(any(target_os = "macos", test))]
pub(super) fn fingerprints(xml: &str) -> BTreeSet<String> {
    let mut entries = vec![];
    let mut offset = 0;
    while let Some(start) = xml[offset..].find("<key>") {
        let begin = offset + start;
        let rest = &xml[begin + 5..];
        let Some(end) = rest.find("</key>") else {
            break;
        };
        if end == 40 && rest[..end].bytes().all(|b| b.is_ascii_hexdigit()) {
            entries.push((begin, rest[..end].to_uppercase()));
        }
        offset = begin + 5 + end + 6;
    }
    let mut allowed = BTreeSet::new();
    for (index, (start, key)) in entries.iter().enumerate() {
        let end = entries.get(index + 1).map(|(i, _)| *i).unwrap_or(xml.len());
        let body = &xml[*start..end];
        let denied = body
            .split("<key>kSecTrustSettingsResult</key>")
            .skip(1)
            .any(|s| {
                s.trim_start_matches(environment::space)
                    .starts_with("<integer>3</integer>")
            });
        if !denied {
            allowed.insert(key.clone());
        }
    }
    allowed
}
#[cfg(any(target_os = "macos", test))]
pub(super) fn selected(pem: &str, allowed: &BTreeSet<String>) -> Vec<(String, Certificate)> {
    let mut seen = BTreeSet::new();
    certificates(pem, false)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, pem, cert)| {
            if allowed.contains(&key) && seen.insert(key) {
                Some((pem, cert))
            } else {
                None
            }
        })
        .collect()
}
