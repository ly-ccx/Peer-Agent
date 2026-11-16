use base64::{Engine, engine::general_purpose::STANDARD};
use peer_runtime::qoder::{self, CacheFormat, FormatError};
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/qoder-formats.json"
    ))
    .unwrap()
}
#[test]
fn official_sdk_credential_vectors_decrypt_without_a_vm_or_cli() {
    for case in fixtures()["credential"].as_array().unwrap() {
        let result = qoder::decrypt_credential(
            case["encoded"].as_str().unwrap(),
            case["key"].as_str().unwrap().as_bytes(),
        )
        .unwrap();
        assert_eq!(result.expose(), case["plain"].as_str().unwrap());
    }
}
#[test]
fn official_sdk_gcm_and_legacy_catalog_vectors_preserve_their_distinct_formats() {
    for case in fixtures()["cache"].as_array().unwrap() {
        let result = qoder::decrypt_cache(
            case["encoded"].as_str().unwrap(),
            case["uid"].as_str().unwrap().as_bytes(),
        );
        if case.get("error").is_some() {
            assert!(matches!(result, Err(FormatError::Cipher)));
        } else {
            let result = result.unwrap();
            assert_eq!(result.format, CacheFormat::GcmV1);
            assert_eq!(result.text.expose(), case["expected"].as_str().unwrap());
        }
    }
    for case in fixtures()["legacy"].as_array().unwrap() {
        let result = qoder::decrypt_cache(case["input"].as_str().unwrap(), b"fixture");
        if case.get("error").is_some() {
            assert!(result.is_err());
        } else {
            let result = result.unwrap();
            assert_ne!(result.format, CacheFormat::GcmV1);
            assert_eq!(result.text.expose(), case["expected"].as_str().unwrap());
        }
    }
}
#[test]
fn official_sdk_wire_vectors_include_actual_ts_message_builder_inputs() {
    for case in fixtures()["body"].as_array().unwrap() {
        let encoded = qoder::encode_body(case["plain"].as_str().unwrap()).unwrap();
        assert_eq!(encoded.expose(), case["encoded"].as_str().unwrap());
        let decoded = qoder::decode_body(encoded.expose()).unwrap();
        assert_eq!(decoded.expose(), case["plain"].as_str().unwrap());
    }
}
#[test]
fn cryptographic_and_encoding_failures_return_no_partial_plaintext_and_later_valid_reads_work() {
    let data = fixtures();
    let case = &data["credential"][1];
    let key = case["key"].as_str().unwrap().as_bytes();
    let encoded = case["encoded"].as_str().unwrap();
    assert!(matches!(
        qoder::decrypt_credential(encoded, b"short"),
        Err(FormatError::Key)
    ));
    assert!(matches!(
        qoder::decrypt_credential("!", key),
        Err(FormatError::Encoding)
    ));
    assert!(matches!(
        qoder::decrypt_credential(&STANDARD.encode([0u8; 17]), key),
        Err(FormatError::Cipher)
    ));
    // A valid CBC envelope containing invalid UTF-8 must still not return text.
    use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
    let mut raw = [0u8; 16];
    raw[0] = 0xff;
    let cipher = cbc::Encryptor::<aes::Aes128>::new_from_slices(key, key)
        .unwrap()
        .encrypt_padded_mut::<Pkcs7>(&mut raw, 1)
        .unwrap();
    assert!(matches!(
        qoder::decrypt_credential(&STANDARD.encode(cipher), key),
        Err(FormatError::Utf8)
    ));
    let mut corrupt = STANDARD.decode(encoded).unwrap();
    let last = corrupt.len() - 1;
    corrupt[last] ^= 1;
    assert!(qoder::decrypt_credential(&STANDARD.encode(corrupt), key).is_err());
    let cache = &data["cache"][1];
    let original = STANDARD.decode(cache["encoded"].as_str().unwrap()).unwrap();
    for at in 4..original.len() {
        let mut tampered = original.clone();
        tampered[at] ^= 1;
        assert!(matches!(
            qoder::decrypt_cache(&STANDARD.encode(tampered), b"fixture-uid"),
            Err(FormatError::Cipher)
        ));
    }
    assert!(matches!(
        qoder::decrypt_cache(cache["encoded"].as_str().unwrap(), b"other"),
        Err(FormatError::Cipher)
    ));
    let mut future = original.clone();
    future[3] = 2;
    assert!(matches!(
        qoder::decrypt_cache(&STANDARD.encode(future), b"fixture-uid"),
        Err(FormatError::Version)
    ));
    for bad in ["A", "====", "$$$$", "ab=c", "🙂", "%%%%"] {
        assert!(qoder::decode_body(bad).is_err(), "{bad}");
    }
    assert!(matches!(
        qoder::decrypt_credential(&"x".repeat(qoder::CREDENTIAL_LIMIT + 1), key),
        Err(FormatError::Limit)
    ));
    assert!(matches!(
        qoder::decrypt_cache(&"x".repeat(qoder::CACHE_LIMIT + 1), b"uid"),
        Err(FormatError::Limit)
    ));
    assert!(matches!(
        qoder::encode_body(&"x".repeat(qoder::BODY_LIMIT + 1)),
        Err(FormatError::Limit)
    ));
    assert!(matches!(
        qoder::decode_body(&"x".repeat(qoder::BODY_LIMIT.div_ceil(3) * 4 + 1)),
        Err(FormatError::Limit)
    ));
    assert_eq!(
        qoder::decrypt_credential(encoded, key).unwrap().expose(),
        case["plain"].as_str().unwrap()
    );
    assert_eq!(
        qoder::decrypt_cache(cache["encoded"].as_str().unwrap(), b"fixture-uid")
            .unwrap()
            .text
            .expose(),
        cache["expected"].as_str().unwrap()
    );
}
