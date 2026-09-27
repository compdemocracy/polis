#![allow(clippy::unwrap_used)]
#![cfg(feature = "tls-tests")]
use polis_coordinator::database::{DatabaseError as E, parse};
fn check(dsn: &str, file: bool) -> Result<postgres::Config, E> {
    parse(dsn, &["localhost".into(), "127.0.0.1".into()], file)
}
#[test]
fn tls_required_for_both_dsn_syntaxes() {
    for dsn in [
        "host=localhost user=test",
        "host='localhost' sslmode='verify-full'",
        "postgresql://test@localhost/db?sslmode=verify-full",
        "postgres://test@127.0.0.1/db",
    ] {
        assert_eq!(
            check(dsn, false).unwrap().get_ssl_mode(),
            postgres::config::SslMode::Require
        );
    }
}
#[test]
fn weaker_modes_never_pass() {
    for mode in [
        "disable",
        "allow",
        "prefer",
        "require",
        "verify-ca",
        "",
        "VERIFY-FULL",
    ] {
        for dsn in [
            format!("host=localhost sslmode={mode}"),
            format!("postgres://localhost/db?sslmode={mode}"),
        ] {
            assert_eq!(check(&dsn, false).unwrap_err(), E::SslMode);
        }
    }
}
#[test]
fn duplicate_or_encoded_options_cannot_override_policy() {
    for dsn in [
        "host=localhost sslmode=verify-full sslmode=disable",
        "postgres://localhost/db?sslmode=verify-full&sslmode=disable",
        "postgres://localhost/db?%73slmode=verify-full&sslmode=disable",
        "host=localhost host=evil",
        "postgres://localhost/db?sslmode=%xx",
    ] {
        assert_eq!(check(dsn, false).unwrap_err(), E::Dsn);
    }
    assert_eq!(
        check("postgres://localhost/db?%73slmode=disable", false).unwrap_err(),
        E::SslMode
    );
    assert!(check("postgres://localhost/db?sslmode=verify%2Dfull", false).is_ok());
}
#[test]
fn all_hosts_must_be_explicitly_allowed() {
    for dsn in [
        "user=test",
        "host=/tmp",
        "host=evil",
        "host=localhost,evil",
        "host=localhost hostaddr=127.0.0.1",
        "postgres://localhost/db?host=evil",
        "postgres://localhost,evil/db",
    ] {
        assert_eq!(check(dsn, false).unwrap_err(), E::Host);
    }
    assert!(parse("host=localhost", &[], false).is_err());
}
#[test]
fn secret_file_and_embedded_password_conflict() {
    for dsn in [
        "host=localhost password=secret",
        "host=localhost password=''",
        "postgres://test:secret@localhost/db",
        "postgres://localhost/db?password=secret",
    ] {
        assert_eq!(check(dsn, true).unwrap_err(), E::PasswordConflict);
        assert!(check(dsn, false).is_ok());
    }
}
#[test]
fn quoted_password_is_data_and_errors_are_closed() {
    assert!(check("host=localhost password='sslmode=disable \\' x'", false).is_ok());
    let error = check("host=localhost nonsense='fixture-secret'", false).unwrap_err();
    assert_eq!(error.to_string(), "DB-DSN-REFUSED");
    assert!(!format!("{error:?}").contains("fixture-secret"));
}
#[test]
fn plaintext_connectors_do_not_exist() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for file in std::fs::read_dir(src).unwrap() {
        let file = file.unwrap().path();
        if file.extension().is_some_and(|e| e == "rs") {
            assert!(!std::fs::read_to_string(file).unwrap().contains("NoTls"));
        }
    }
}
