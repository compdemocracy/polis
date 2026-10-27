#![allow(clippy::unwrap_used)]
use base64::{Engine, engine::general_purpose::STANDARD};
use polis_auth::{Uid, keys::Keys};
use serde_json::Value;
use std::{ffi::OsString, fs, path::PathBuf, process::Command, sync::OnceLock};

fn fixture() -> &'static Value {
    static FIXTURE: OnceLock<Value> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let result = Command::new("node")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/participant-keys.cjs"
            ))
            .output()
            .unwrap();
        assert!(result.status.success(), "Node key fixture failed");
        serde_json::from_slice(&result.stdout).unwrap()
    })
}

fn load(settings: &[(&str, &str)]) -> Result<Keys, polis_auth::keys::LoadError> {
    Keys::from_environment(|name| {
        settings
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| OsString::from(value))
    })
}

fn private() -> &'static str {
    fixture()["privateKey"].as_str().unwrap()
}
fn public() -> &'static str {
    fixture()["publicKey"].as_str().unwrap()
}

fn verify(keys: &Keys) {
    assert_eq!(
        keys.fingerprint(),
        fixture()["fingerprint"].as_str().unwrap()
    );
    let verifier = keys.verifier("https://pol.is/", "participants").unwrap();
    let token = format!("Bearer {}", fixture()["token"].as_str().unwrap());
    assert_eq!(
        verifier
            .verify(&token, "2jwt-test", 1800000000)
            .unwrap()
            .uid(),
        Uid(3)
    );
    let _future_signer = keys.private_key();
}

struct Files(PathBuf);
impl Files {
    fn new() -> Self {
        let name = format!(
            "participant-keys-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(name);
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn write(&self, name: &str, contents: &str) -> String {
        use std::io::Write;
        let path = self.0.join(name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&path)
            .unwrap()
            .write_all(contents.as_bytes())
            .unwrap();
        path.to_str().unwrap().to_owned()
    }
}
impl Drop for Files {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn node_token_and_fingerprint_match_values_escaped_values_base64_and_paths() {
    for (private, public) in [
        (private().to_owned(), public().to_owned()),
        (
            private().replace('\n', "\\n"),
            public().replace('\n', "\\n"),
        ),
        (STANDARD.encode(private()), STANDARD.encode(public())),
    ] {
        let keys = load(&[
            ("JWT_PRIVATE_KEY", &private),
            ("JWT_PUBLIC_KEY", &public),
            ("JWT_PRIVATE_KEY_PATH", "/does-not-exist"),
            ("JWT_PUBLIC_KEY_PATH", "/does-not-exist"),
        ])
        .unwrap();
        verify(&keys);
    }
    let files = Files::new();
    let private_path = files.write("private.pem", private());
    let public_path = files.write("public.pem", public());
    let keys = load(&[
        ("JWT_PRIVATE_KEY_PATH", &private_path),
        ("JWT_PUBLIC_KEY_PATH", &public_path),
        ("JWT_PRIVATE_KEY", ""),
        ("JWT_PUBLIC_KEY", ""),
    ])
    .unwrap();
    verify(&keys);
    // The parsed handles survive removal of both source files.
    drop(files);
    verify(&keys);
}

#[test]
fn forms_can_be_mixed_and_pkcs1_has_the_same_fingerprint() {
    let files = Files::new();
    let private_path = files.write("private.pem", private());
    verify(
        &load(&[
            ("JWT_PRIVATE_KEY_PATH", &private_path),
            ("JWT_PUBLIC_KEY", public()),
        ])
        .unwrap(),
    );
    let public_path = files.write("public.pem", public());
    verify(
        &load(&[
            ("JWT_PRIVATE_KEY", private()),
            ("JWT_PUBLIC_KEY_PATH", &public_path),
        ])
        .unwrap(),
    );
    let rsa = openssl::rsa::Rsa::private_key_from_pem(private().as_bytes()).unwrap();
    let pkcs1_private = String::from_utf8(rsa.private_key_to_pem().unwrap()).unwrap();
    let pkcs1_public = String::from_utf8(rsa.public_key_to_pem_pkcs1().unwrap()).unwrap();
    verify(
        &load(&[
            ("JWT_PRIVATE_KEY", &pkcs1_private),
            ("JWT_PUBLIC_KEY", &pkcs1_public),
        ])
        .unwrap(),
    );
}

#[test]
fn bad_pairs_name_only_the_settings_and_never_fall_back_from_bad_values() {
    let files = Files::new();
    let private_path = files.write("private.pem", private());
    let public_path = files.write("public.pem", public());
    let bad_path = files.write("bad.pem", "sensitive malformed value");
    let other = openssl::rsa::Rsa::generate(2048).unwrap();
    let other_public = String::from_utf8(other.public_key_to_pem().unwrap()).unwrap();
    for (settings, names) in [
        (
            vec![("JWT_PRIVATE_KEY_PATH", "/missing-sensitive-path")],
            vec!["JWT_PRIVATE_KEY_PATH", "JWT_PRIVATE_KEY"],
        ),
        (
            vec![
                ("JWT_PRIVATE_KEY", private()),
                ("JWT_PUBLIC_KEY_PATH", "/missing-sensitive-path"),
            ],
            vec!["JWT_PUBLIC_KEY_PATH", "JWT_PUBLIC_KEY"],
        ),
        (
            vec![
                ("JWT_PRIVATE_KEY", "sensitive malformed value"),
                ("JWT_PUBLIC_KEY", public()),
                ("JWT_PRIVATE_KEY_PATH", &private_path),
            ],
            vec!["JWT_PRIVATE_KEY"],
        ),
        (
            vec![
                ("JWT_PRIVATE_KEY", private()),
                ("JWT_PUBLIC_KEY", "sensitive malformed value"),
                ("JWT_PUBLIC_KEY_PATH", &public_path),
            ],
            vec!["JWT_PUBLIC_KEY"],
        ),
        (
            vec![
                ("JWT_PRIVATE_KEY_PATH", &bad_path),
                ("JWT_PUBLIC_KEY", public()),
            ],
            vec!["JWT_PRIVATE_KEY_PATH"],
        ),
        (
            vec![
                ("JWT_PRIVATE_KEY", private()),
                ("JWT_PUBLIC_KEY_PATH", &bad_path),
            ],
            vec!["JWT_PUBLIC_KEY_PATH"],
        ),
        (
            vec![
                ("JWT_PRIVATE_KEY", private()),
                ("JWT_PUBLIC_KEY", &other_public),
            ],
            vec!["JWT_PRIVATE_KEY", "JWT_PUBLIC_KEY"],
        ),
        (
            vec![
                ("JWT_PRIVATE_KEY_PATH", &private_path),
                ("JWT_PUBLIC_KEY", &other_public),
            ],
            vec!["JWT_PRIVATE_KEY_PATH", "JWT_PUBLIC_KEY"],
        ),
    ] {
        let error = load(&settings).err().unwrap();
        let message = format!("{error} {error:?}");
        for name in names {
            assert!(message.contains(name));
        }
        for secret in [private(), public(), "sensitive", &other_public] {
            assert!(!message.contains(secret));
        }
        assert!(!message.contains('\n'));
    }
}
