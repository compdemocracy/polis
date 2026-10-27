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
            vec![],
            "JWT_PRIVATE_KEY_PATH could not be read; set JWT_PRIVATE_KEY or JWT_PRIVATE_KEY_PATH to a readable key file",
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
