//! Participant key custody. Load once before accepting requests; no key material
//! or underlying parser/file error is included in diagnostics.
use base64::{
    Engine, alphabet,
    engine::{GeneralPurpose, general_purpose::NO_PAD},
};
use jsonwebtoken::{DecodingKey, EncodingKey};
use openssl::{pkey::PKey, rsa::Rsa, sha::sha256};
use std::{ffi::OsString, fmt};

/// Deliberately has no Debug or serialization implementation.
pub struct Keys {
    private: EncodingKey,
    public: DecodingKey,
    fingerprint: String,
}

/// Contains only fixed setting names and plain words, never supplied values.
#[derive(Debug)]
pub struct LoadError(String);
impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for LoadError {}

fn invalid(setting: &str) -> LoadError {
    LoadError(format!("{setting} must contain a valid RSA key"))
}

fn read_key(
    get: &impl Fn(&str) -> Option<OsString>,
    value_name: &'static str,
    path_name: &'static str,
    default_path: &str,
) -> Result<(Vec<u8>, &'static str), LoadError> {
    if let Some(value) = get(value_name).filter(|v| !v.is_empty()) {
        let value = value.into_string().map_err(|_| invalid(value_name))?;
        // Node's Buffer.from(value, "base64") also accepts URL-safe characters,
        // ignores whitespace/non-alphabet characters and stops at padding.
        let pem = if value.contains("BEGIN") {
            value.replace("\\n", "\n").into_bytes()
        } else {
            let mut encoded: Vec<u8> = value
                .bytes()
                .take_while(|b| *b != b'=')
                .filter_map(|b| match b {
                    b'-' => Some(b'+'),
                    b'_' => Some(b'/'),
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(b),
                    _ => None,
                })
                .collect();
            if encoded.len() % 4 == 1 {
                encoded.pop();
            }
            GeneralPurpose::new(
                &alphabet::STANDARD,
                NO_PAD.with_decode_allow_trailing_bits(true),
            )
            .decode(encoded)
            .map_err(|_| invalid(value_name))?
        };
        return Ok((pem, value_name));
    }
    let path = get(path_name)
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| default_path.into());
    let pem = std::fs::read(path).map_err(|_| {
        LoadError(format!(
            "{path_name} could not be read; set {value_name} or {path_name} to a readable key file"
        ))
    })?;
    Ok((pem, path_name))
}

impl Keys {
    pub fn from_env() -> Result<Self, LoadError> {
        Self::from_environment(|name| std::env::var_os(name))
    }

    /// Absent keys are allowed when nothing in the process needs them: a box
    /// that routes no participant traffic to this service boots without them
    /// and reports `participantKeysLoaded: false`. A present but malformed,
    /// unreadable or mismatched pair still refuses to boot.
    pub fn from_env_optional() -> Result<Option<Self>, LoadError> {
        Self::from_environment_optional(|name| std::env::var_os(name))
    }

    pub fn from_environment_optional(
        get: impl Fn(&str) -> Option<OsString>,
    ) -> Result<Option<Self>, LoadError> {
        let absent = |value_name: &str, path_name: &str, default_path: &str| {
            get(value_name).filter(|v| !v.is_empty()).is_none()
                && get(path_name).filter(|v| !v.is_empty()).is_none()
                && !std::path::Path::new(default_path).exists()
        };
        if absent(
            "JWT_PRIVATE_KEY",
            "JWT_PRIVATE_KEY_PATH",
            "/app/keys/jwt-private.pem",
        ) && absent(
            "JWT_PUBLIC_KEY",
            "JWT_PUBLIC_KEY_PATH",
            "/app/keys/jwt-public.pem",
        ) {
            return Ok(None);
        }
        Self::from_environment(get).map(Some)
    }

    /// An injectable environment reader avoids changing global process state in
    /// tests. Values take precedence independently for each half of the pair.
    pub fn from_environment(get: impl Fn(&str) -> Option<OsString>) -> Result<Self, LoadError> {
        let (private_pem, private_name) = read_key(
            &get,
            "JWT_PRIVATE_KEY",
            "JWT_PRIVATE_KEY_PATH",
            "/app/keys/jwt-private.pem",
        )?;
        let (public_pem, public_name) = read_key(
            &get,
            "JWT_PUBLIC_KEY",
            "JWT_PUBLIC_KEY_PATH",
            "/app/keys/jwt-public.pem",
        )?;
        let private = PKey::private_key_from_pem_callback(&private_pem, |_| Ok(0))
            .map_err(|_| invalid(private_name))?;
        let rsa = private.rsa().map_err(|_| invalid(private_name))?;
        if !rsa.check_key().map_err(|_| invalid(private_name))? || rsa.size() < 256 {
            return Err(invalid(private_name));
        }
        let public = PKey::public_key_from_pem(&public_pem)
            .or_else(|_| Rsa::public_key_from_pem_pkcs1(&public_pem).and_then(PKey::from_rsa))
            .map_err(|_| invalid(public_name))?;
        public.rsa().map_err(|_| invalid(public_name))?;
        if !private.public_eq(&public) {
            return Err(LoadError(format!(
                "{private_name} and {public_name} must be the same RSA key pair"
            )));
        }
        let der = public
            .public_key_to_der()
            .map_err(|_| invalid(public_name))?;
        let fingerprint = sha256(&der).iter().map(|b| format!("{b:02x}")).collect();
        // Normalize PEM envelopes for the JWT library after validating the pair.
        let private = EncodingKey::from_rsa_pem(
            &rsa.private_key_to_pem()
                .map_err(|_| invalid(private_name))?,
        )
        .map_err(|_| invalid(private_name))?;
        let public = DecodingKey::from_rsa_pem(
            &public
                .public_key_to_pem()
                .map_err(|_| invalid(public_name))?,
        )
        .map_err(|_| invalid(public_name))?;
        Ok(Self {
            private,
            public,
            fingerprint,
        })
    }

    /// Reserved for a future minter. Loading a key does not issue a token.
    pub fn private_key(&self) -> &EncodingKey {
        &self.private
    }

    /// Lowercase SHA-256 hex of the public key's SPKI DER encoding.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn verifier(&self, issuer: &str, audience: &str) -> Option<crate::participant::Verifier> {
        crate::participant::Verifier::from_key(self.public.clone(), issuer, audience)
    }
}
