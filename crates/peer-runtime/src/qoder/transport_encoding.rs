//! Vendor wire obfuscation, not encryption or authentication.
use super::{BODY_LIMIT, FormatError, PrivateText};
use base64::{
    Engine,
    alphabet::Alphabet,
    engine::{GeneralPurpose, GeneralPurposeConfig},
};
use std::sync::OnceLock;
use zeroize::Zeroizing;

fn codec() -> &'static GeneralPurpose {
    static CODEC: OnceLock<GeneralPurpose> = OnceLock::new();
    CODEC.get_or_init(|| {
        GeneralPurpose::new(
            &Alphabet::new("_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!")
                .expect("fixed vendor alphabet"),
            GeneralPurposeConfig::new(),
        )
    })
}
fn swap_thirds(bytes: &mut [u8]) {
    let third = bytes.len() / 3;
    for i in 0..third {
        bytes.swap(i, bytes.len() - third + i);
    }
}
pub fn encode_body(text: &str) -> Result<PrivateText, FormatError> {
    if text.len() > BODY_LIMIT {
        return Err(FormatError::Limit);
    }
    let mut bytes = Zeroizing::new(codec().encode(text.as_bytes()).into_bytes());
    for b in bytes.iter_mut() {
        if *b == b'=' {
            *b = b'$';
        }
    }
    swap_thirds(&mut bytes);
    PrivateText::new(bytes)
}
pub fn decode_body(text: &str) -> Result<PrivateText, FormatError> {
    if text.len() > BODY_LIMIT.div_ceil(3) * 4 {
        return Err(FormatError::Limit);
    }
    if !text.len().is_multiple_of(4) {
        return Err(FormatError::Encoding);
    }
    let mut bytes = Zeroizing::new(text.as_bytes().to_vec());
    swap_thirds(&mut bytes);
    // '=' is not a vendor alphabet symbol; only '$' can represent padding.
    if bytes.contains(&b'=') {
        return Err(FormatError::Encoding);
    }
    for b in bytes.iter_mut() {
        if *b == b'$' {
            *b = b'=';
        }
    }
    let mut decoded = Zeroizing::new(Vec::new());
    codec()
        .decode_vec(&bytes, &mut decoded)
        .map_err(|_| FormatError::Encoding)?;
    if decoded.len() > BODY_LIMIT {
        return Err(FormatError::Limit);
    }
    PrivateText::new(decoded)
}
