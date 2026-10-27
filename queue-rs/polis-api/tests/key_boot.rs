//! Boot failures must happen before database setup or opening a listener.
#![allow(clippy::unwrap_used)]
use std::process::Command;

#[test]
fn missing_unreadable_malformed_and_mismatched_keys_refuse_boot() {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let private = String::from_utf8(rsa.private_key_to_pem().unwrap()).unwrap();
    let public = String::from_utf8(rsa.public_key_to_pem().unwrap()).unwrap();
    let other = openssl::rsa::Rsa::generate(2048).unwrap();
    let other_public = String::from_utf8(other.public_key_to_pem().unwrap()).unwrap();
    let encrypted = String::from_utf8(
        rsa.private_key_to_pem_passphrase(
            openssl::symm::Cipher::aes_256_cbc(),
            b"test-only-passphrase",
        )
        .unwrap(),
    )
    .unwrap();
    for (settings, expected) in [
        (
            vec![
                ("JWT_PRIVATE_KEY", encrypted.as_str()),
                ("JWT_PUBLIC_KEY", public.as_str()),
            ],
            "JWT_PRIVATE_KEY must contain a valid RSA key",
        ),
        (
            vec![("POLIS_API_PARTICIPANT_READS", "1")],
            "JWT_PUBLIC_KEY_PATH could not be read; set JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH to a readable key file",
        ),
        (
            vec![("JWT_PRIVATE_KEY", private.as_str())],
            "JWT_PUBLIC_KEY_PATH could not be read; set JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH to a readable key file",
        ),
        (
            vec![("JWT_PRIVATE_KEY_PATH", "/unreadable-private-fixture")],
            "JWT_PRIVATE_KEY_PATH could not be read; set JWT_PRIVATE_KEY or JWT_PRIVATE_KEY_PATH to a readable key file",
        ),
        (
            vec![
                ("JWT_PRIVATE_KEY", "malformed-private-fixture"),
                ("JWT_PUBLIC_KEY", public.as_str()),
            ],
            "JWT_PRIVATE_KEY must contain a valid RSA key",
        ),
        (
            vec![
                ("JWT_PRIVATE_KEY", private.as_str()),
                ("JWT_PUBLIC_KEY", "malformed-public-fixture"),
            ],
            "JWT_PUBLIC_KEY must contain a valid RSA key",
        ),
        (
            vec![
                ("JWT_PRIVATE_KEY", private.as_str()),
                ("JWT_PUBLIC_KEY", other_public.as_str()),
            ],
            "JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be the same RSA key pair",
        ),
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_polis-api"))
            .env_clear()
            .envs(settings)
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
        assert_eq!(
            String::from_utf8(result.stderr).unwrap(),
            format!("Error: {expected}\n")
        );
    }
}

#[test]
fn absent_keys_without_a_participant_route_do_not_refuse_boot() {
    let result = Command::new(env!("CARGO_BIN_EXE_polis-api"))
        .env_clear()
        .output()
        .unwrap();
    let stderr = String::from_utf8(result.stderr).unwrap();
    assert!(
        stderr.contains("participant signing keys not configured"),
        "{stderr}"
    );
    assert!(!stderr.contains("could not be read"), "{stderr}");
}

#[test]
fn a_public_key_alone_is_enough_to_verify_and_the_legacy_path_setting_is_accepted() {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = String::from_utf8(rsa.public_key_to_pem().unwrap()).unwrap();
    let dir = std::env::temp_dir().join(format!("polis-api-key-boot-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("participant-public.pem");
    std::fs::write(&path, &public).unwrap();
    for settings in [
        vec![
            ("POLIS_API_PARTICIPANT_READS", "1".to_string()),
            ("JWT_PUBLIC_KEY", public.clone()),
        ],
        vec![
            ("POLIS_API_PARTICIPANT_READS", "1".to_string()),
            (
                "POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE",
                path.to_string_lossy().into_owned(),
            ),
        ],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_polis-api"))
            .env_clear()
            .envs(settings)
            .output()
            .unwrap();
        let stderr = String::from_utf8(result.stderr).unwrap();
        // Boot gets past the keys: whatever stops it next is not a key message.
        assert!(!stderr.contains("JWT_"), "{stderr}");
        assert!(
            !stderr.contains("participant signing keys not configured"),
            "{stderr}"
        );
    }
    std::fs::remove_dir_all(&dir).unwrap();
}
