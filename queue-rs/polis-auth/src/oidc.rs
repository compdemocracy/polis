//! Staged OIDC first use; no route calls this module.
//!
//! The caller verifies the token first, then provisions on EVERY authenticated
//! request (including reads), BEFORE route field validation. That ordering is a
//! caller contract, not a decision made here. Use a bounded primary connection;
//! no provider fetch, signing, or slow callback belongs in the transaction.
use crate::{
    Uid,
    observability::{Counters, Event},
};
use postgres::{Client, GenericClient, error::SqlState};
use serde_json::Value;

/// Mapped verified claims. No Debug: profile/credential values are not logs.
/// email_verified and delphi_enabled are request metadata, never persisted by
/// Node's provisioning SQL and never grounds for escalating account privileges.
pub struct Profile {
    pub subject: String,
    pub email: String,
    pub display_name: String,
    pub username: String,
    pub email_verified: Option<Value>,
    pub delphi_enabled: Option<Value>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidUserData,
    Unavailable,
    /// An unacknowledged COMMIT is not proof of rollback. Never blindly retry.
    CommitUnknown,
}

impl Profile {
    /// Only call with claims whose signature, issuer, audience and time have
    /// already been verified. Empty strings follow JavaScript's || fallbacks;
    /// whitespace is preserved. Malformed non-string profile fields refuse.
    pub fn from_verified_claims(claims: &Value, namespace: &str) -> Result<Self, Error> {
        fn string(v: Option<&Value>) -> Result<Option<&str>, Error> {
            match v {
                None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(None),
                Some(Value::Number(n)) if n.as_f64() == Some(0.0) => Ok(None),
                Some(Value::String(s)) => Ok((!s.is_empty()).then_some(s)),
                _ => Err(Error::InvalidUserData),
            }
        }
        let subject = string(claims.get("sub"))?.ok_or(Error::InvalidUserData)?;
        if subject.len() > 255 {
            return Err(Error::InvalidUserData);
        }
        let email = match string(claims.get("email"))? {
            Some(s) => s,
            None => {
                string(claims.get(format!("{namespace}email")))?.ok_or(Error::InvalidUserData)?
            }
        };
        let nickname = string(claims.get("nickname"))?;
        let name = match string(claims.get("name"))? {
            Some(s) => Some(s),
            None => string(claims.get(format!("{namespace}name")))?,
        };
        let local = email.split('@').next().unwrap_or("");
        Ok(Self {
            subject: subject.into(),
            email: email.into(),
            display_name: name.or(nickname).unwrap_or(local).into(),
            username: nickname.unwrap_or(local).into(),
            email_verified: claims.get("email_verified").cloned(),
            delphi_enabled: claims.get(format!("{namespace}delphi_enabled")).cloned(),
        })
    }
}

/// One complete transaction per attempt, with the admission timeout policy.
/// Uniqueness losers roll back the account AND mapping before re-resolving on
/// primary (three attempts maximum); lock timeouts are never retried.
pub fn provision(
    client: &mut Client,
    profile: &Profile,
    counters: &Counters,
) -> Result<Uid, Error> {
    for attempt in 0..3 {
        let mut tx = crate::transaction::begin(client).map_err(|_| Error::Unavailable)?;
        match resolve(&mut PostgresStore(&mut tx), profile) {
            Ok((uid, created)) => {
                tx.commit().map_err(|_| Error::CommitUnknown)?;
                if created {
                    counters.record(Event::UserCreatedOidc);
                }
                return Ok(uid);
            }
            Err(error) => {
                tx.rollback().map_err(|_| Error::Unavailable)?;
                if error.code() == Some(&SqlState::LOCK_NOT_AVAILABLE) {
                    counters.record(Event::LockTimeout);
                }
                if error.code() == Some(&SqlState::UNIQUE_VIOLATION) && attempt < 2 {
                    counters.record(Event::UniqueViolationRetry);
                } else {
                    return Err(Error::Unavailable);
                }
            }
        }
    }
    Err(Error::Unavailable)
}

trait Store {
    type Error;
    fn mapping(&mut self, sub: &str) -> Result<Option<Uid>, Self::Error>;
    fn account(&mut self, p: &Profile) -> Result<(Uid, bool), Self::Error>;
    fn replace_mapping(&mut self, sub: &str, uid: Uid) -> Result<(), Self::Error>;
}
fn resolve<S: Store>(store: &mut S, p: &Profile) -> Result<(Uid, bool), S::Error> {
    if let Some(uid) = store.mapping(&p.subject)? {
        return Ok((uid, false));
    }
    let account = store.account(p)?;
    store.replace_mapping(&p.subject, account.0)?;
    Ok(account)
}
struct PostgresStore<'a, T>(&'a mut T);
impl<T: GenericClient> Store for PostgresStore<'_, T> {
    type Error = postgres::Error;
    fn mapping(&mut self, sub: &str) -> Result<Option<Uid>, Self::Error> {
        self.0
            .query_opt(
                "SELECT uid FROM oidc_user_mappings WHERE oidc_sub=$1",
                &[&sub],
            )?
            .map(|r| r.try_get(0).map(Uid))
            .transpose()
    }
    fn account(&mut self, p: &Profile) -> Result<(Uid, bool), Self::Error> {
        // The default site_id and site_owner are intentionally omitted. On an
        // email conflict, only names change: existing owner rights stay intact.
        let r = self.0.query_one(
            "INSERT INTO users(email,hname,username,is_owner,created)
          VALUES($1,$2,$3,true,now_as_millis())
          ON CONFLICT(email) DO UPDATE SET hname=EXCLUDED.hname,username=EXCLUDED.username
          RETURNING uid, (xmax=0)",
            &[&p.email, &p.display_name, &p.username],
        )?;
        Ok((Uid(r.try_get(0)?), r.try_get(1)?))
    }
    fn replace_mapping(&mut self, sub: &str, uid: Uid) -> Result<(), Self::Error> {
        // The account upsert holds its row lock through COMMIT. A new social
        // login for this email wins. Never delete a concurrent winner for this
        // sub at another uid: the INSERT must conflict and roll back our user.
        if let Some(row) = self.0.query_opt(
            "SELECT oidc_sub FROM oidc_user_mappings WHERE uid=$1",
            &[&uid.0],
        )? && row.try_get::<_, String>(0)? == sub
        {
            return Ok(());
        }
        self.0
            .execute("DELETE FROM oidc_user_mappings WHERE uid=$1", &[&uid.0])?;
        self.0.execute(
            "INSERT INTO oidc_user_mappings(oidc_sub,uid,created) VALUES($1,$2,now_as_millis())",
            &[&sub, &uid.0],
        )?;
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn every_claim_fallback_and_metadata() {
        for (claims, email, display, username) in [
            (
                json!({"email":"e@x","ns/email":"ignored","name":"Name","ns/name":"ignored","nickname":"Nick"}),
                "e@x",
                "Name",
                "Nick",
            ),
            (
                json!({"email":"","ns/email":"e@x","name":"","ns/name":"Namespaced","nickname":"Nick"}),
                "e@x",
                "Namespaced",
                "Nick",
            ),
            (
                json!({"ns/email":"e@x","nickname":"Nick"}),
                "e@x",
                "Nick",
                "Nick",
            ),
            (
                json!({"email":"local@x","name":null,"nickname":""}),
                "local@x",
                "local",
                "local",
            ),
            (json!({"email":"no-at"}), "no-at", "no-at", "no-at"),
            (json!({"email":"@x"}), "@x", "", ""),
            (
                json!({"email":" ","name":" ","nickname":" "}),
                " ",
                " ",
                " ",
            ),
            (
                json!({"email":false,"ns/email":"e@x","name":0,"ns/name":"N"}),
                "e@x",
                "N",
                "e",
            ),
        ] {
            let mut claims = claims;
            claims["sub"] = json!("subject");
            claims["email_verified"] = json!(false);
            claims["ns/delphi_enabled"] = json!(true);
            let p = Profile::from_verified_claims(&claims, "ns/").unwrap();
            assert_eq!(
                (&*p.email, &*p.display_name, &*p.username),
                (email, display, username)
            );
            assert_eq!(p.email_verified, Some(json!(false)));
            assert_eq!(p.delphi_enabled, Some(json!(true)));
        }
        for c in [
            json!({"sub":"s"}),
            json!({"email":"e"}),
            json!({"sub":"s","email":true}),
            json!({"sub":"s","email":"e","nickname":[]}),
        ] {
            assert!(matches!(
                Profile::from_verified_claims(&c, "ns/"),
                Err(Error::InvalidUserData)
            ));
        }
    }
    struct Fake {
        hit: Option<Uid>,
        calls: Vec<&'static str>,
    }
    impl Store for Fake {
        type Error = ();
        fn mapping(&mut self, _: &str) -> Result<Option<Uid>, ()> {
            self.calls.push("lookup");
            Ok(self.hit)
        }
        fn account(&mut self, _: &Profile) -> Result<(Uid, bool), ()> {
            self.calls.push("email conflict names");
            Ok((Uid(7), false))
        }
        fn replace_mapping(&mut self, _: &str, uid: Uid) -> Result<(), ()> {
            assert_eq!(uid, Uid(7));
            self.calls.push("replace mapping");
            Ok(())
        }
    }
    #[test]
    fn hit_does_not_update_profile_and_conflict_replaces_mapping() {
        let p = Profile::from_verified_claims(&json!({"sub":"s","email":"e"}), "ns/").unwrap();
        for hit in [Some(Uid(7)), None] {
            let mut f = Fake { hit, calls: vec![] };
            assert_eq!(resolve(&mut f, &p), Ok((Uid(7), false)));
            assert_eq!(
                f.calls,
                if hit.is_some() {
                    vec!["lookup"]
                } else {
                    vec!["lookup", "email conflict names", "replace mapping"]
                }
            );
        }
    }
}
