//! The process locale, independent of model arguments and UI language.
use super::*;
use icu_collator::{Collator, CollatorBorrowed};
use icu_locale_core::Locale;

pub(super) struct FileLocale {
    pub locale: Locale,
    collator: CollatorBorrowed<'static>,
}
impl FileLocale {
    pub fn current() -> Result<Self, HostError> {
        let raw = ["LC_ALL", "LC_MESSAGES", "LANG"]
            .into_iter()
            .filter_map(|key| std::env::var(key).ok())
            .find(|s| !s.is_empty())
            .unwrap_or_default();
        Self::new(&raw)
    }
    pub fn new(raw: &str) -> Result<Self, HostError> {
        let tag = raw.split(['.', '@']).next().unwrap_or("").replace('_', "-");
        let locale = if tag.is_empty() || matches!(tag.as_str(), "C" | "POSIX") {
            "en-US".parse::<Locale>()
        } else {
            tag.parse::<Locale>()
        }
        .unwrap_or_else(|_| "en-US".parse().unwrap());
        let collator = Collator::try_new(locale.clone().into(), Default::default())
            .map_err(|_| HostError("file_locale_unavailable"))?;
        Ok(Self { locale, collator })
    }
    pub fn compare(&self, a: &str, b: &str) -> std::cmp::Ordering {
        self.collator.compare(a, b)
    }
    pub fn lower(&self, text: &str) -> String {
        icu_casemap::CaseMapper::new()
            .lowercase_to_string(text, &self.locale.id)
            .into_owned()
    }
}
