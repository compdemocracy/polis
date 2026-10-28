//! Existing Treevite code derivations, prepared outside database transactions.
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

pub const LIFETIME_SECONDS: u64 = 31_536_000;
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
// No Debug for settings or prepared material.
pub struct Settings {
    lookup_pepper: String,
    fingerprint_key: String,
}
impl Settings {
    pub fn from_lookup(mut get: impl FnMut(&str) -> Option<String>) -> Self {
        let encryption = get("ENCRYPTION_PASSWORD_00001").filter(|s| !s.is_empty());
        Self {
            lookup_pepper: get("LOGIN_CODE_PEPPER")
                .filter(|s| !s.is_empty())
                .or_else(|| encryption.clone())
                .unwrap_or_else(|| "polis_treevite_pepper".into()),
            fingerprint_key: encryption.unwrap_or_else(|| "polis_treevite_fingerprint_key".into()),
        }
    }
    pub fn prepare(&self, zid: i32, pid: i32) -> Result<Prepared, crate::Unavailable> {
        let mut code = String::with_capacity(16);
        // Rejection sampling preserves independent uniform alphabet selections.
        while code.len() < 16 {
            let mut bytes = [0; 32];
            openssl::rand::rand_bytes(&mut bytes).map_err(|_| crate::Unavailable)?;
            for byte in bytes {
                if usize::from(byte) < 256 / ALPHABET.len() * ALPHABET.len() {
                    code.push(ALPHABET[usize::from(byte) % ALPHABET.len()] as char);
                    if code.len() == 16 {
                        break;
                    }
                }
            }
        }
        // bcryptjs emits the 2a prefix; preserve those stored bytes as well as cost.
        let hash = bcrypt::hash_with_result(&code, 10)
            .map_err(|_| crate::Unavailable)?
            .format_for_version(bcrypt::Version::TwoA);
        let lookup = hex(&Sha256::digest(
            format!("{code}{}", self.lookup_pepper).as_bytes(),
        ));
        let mut mac = Hmac::<Sha256>::new_from_slice(self.fingerprint_key.as_bytes())
            .map_err(|_| crate::Unavailable)?;
        mac.update(format!("{zid}:{pid}:{code}").as_bytes());
        let fingerprint = hex(&mac.finalize().into_bytes());
        Ok(Prepared {
            code,
            hash,
            lookup,
            fingerprint,
        })
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub struct Prepared {
    pub code: String,
    pub hash: String,
    pub lookup: String,
    pub fingerprint: String,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn code_format_cost_and_independent_pepper_chains() {
        for (lookup, encryption, expected_lookup, expected_fp) in [
            (
                None,
                None,
                "polis_treevite_pepper",
                "polis_treevite_fingerprint_key",
            ),
            (
                Some(""),
                Some(""),
                "polis_treevite_pepper",
                "polis_treevite_fingerprint_key",
            ),
            (None, Some("encryption"), "encryption", "encryption"),
            (
                Some("dedicated"),
                Some("encryption"),
                "dedicated",
                "encryption",
            ),
            (Some(" "), None, " ", "polis_treevite_fingerprint_key"),
        ] {
            let settings = Settings::from_lookup(|name| match name {
                "LOGIN_CODE_PEPPER" => lookup.map(str::to_owned),
                "ENCRYPTION_PASSWORD_00001" => encryption.map(str::to_owned),
                _ => None,
            });
            assert_eq!(settings.lookup_pepper, expected_lookup);
            assert_eq!(settings.fingerprint_key, expected_fp);
            let prepared = settings.prepare(7, 0).unwrap();
            assert_eq!(prepared.code.len(), 16);
            assert!(prepared.code.bytes().all(|b| ALPHABET.contains(&b)));
            assert!(prepared.hash.starts_with("$2a$10$"));
            assert!(bcrypt::verify(&prepared.code, &prepared.hash).unwrap());
            assert!(!bcrypt::verify("different", &prepared.hash).unwrap());
            assert_eq!(prepared.lookup.len(), 64);
            assert_eq!(prepared.fingerprint.len(), 64);
        }
    }
}
