//! Treevite credential exchanges. No credential-bearing type implements Debug.
use serde::Serialize;

pub const ACCEPT_PATH: &str = "/api/v3/treevite/acceptInvite";
pub const LOGIN_PATH: &str = "/api/v3/treevite/login";
pub const SESSION_SECONDS: u64 = 86400;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Accept,
    Login,
}
impl Operation {
    pub fn from_path(path: &str) -> Option<Self> {
        match path {
            ACCEPT_PATH => Some(Self::Accept),
            LOGIN_PATH => Some(Self::Login),
            _ => None,
        }
    }
    pub fn field(self) -> &'static str {
        match self {
            Self::Accept => "invite_code",
            Self::Login => "login_code",
        }
    }
    pub fn limit(self) -> usize {
        match self {
            Self::Accept => 128,
            Self::Login => 256,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct Auth {
    pub token: String,
    pub token_type: &'static str,
    pub expires_in: u64,
}
#[derive(Clone, Serialize)]
pub struct Accepted {
    pub status: &'static str,
    pub wave_id: String,
    pub invite_id: String,
    pub login_code: String,
    pub auth: Auth,
}
#[derive(Clone, Serialize)]
pub struct LoggedIn {
    pub status: &'static str,
    pub auth: Auth,
}
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum Success {
    Accepted(Accepted),
    LoggedIn(LoggedIn),
    Pending(AcceptedPending),
}
#[derive(Clone, Serialize)]
pub struct AcceptedPending {
    pub status: &'static str,
    pub wave_id: String,
    pub invite_id: String,
    pub login_code: String,
    pub error: &'static str,
    pub retry: &'static str,
}

/// Unknown means the client must not blindly replay an invite. No spent-invite
/// credential or invented recovery nonce is exposed by this contract.
#[derive(Serialize)]
pub struct Unknown {
    pub acceptance: &'static str,
    pub error: &'static str,
    pub retry: &'static str,
}

pub fn trim_code(code: &str) -> &str {
    code.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn code_trimming_is_javascript_not_rust_whitespace() {
        assert_eq!(trim_code("\u{feff} A \n"), "A");
        assert_eq!(trim_code("\u{0085}A"), "\u{0085}A");
    }
}
