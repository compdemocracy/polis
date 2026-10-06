#![allow(clippy::unwrap_used)]
//! The coordinator's startup decision over the database's vote convention
//! (P-078): pure, so no database is needed. The sign this build is built for
//! comes from the configuration default, never from a literal here.
use polis_coordinator::vote_convention::{
    DatabaseConvention, GUIDE, Refusal, SUPPORTED_CONTRACTS, declare_command, judge,
};

/// `STORAGE_AGREE_VALUE`'s default in `config.rs`, read the way the binary does.
fn built_for() -> i64 {
    std::env::var("STORAGE_AGREE_VALUE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(-1)
}
fn other() -> i64 {
    -built_for()
}
const CONTRACT: i32 = SUPPORTED_CONTRACTS[0];

#[test]
fn the_sign_this_build_is_built_for_starts() {
    let found = DatabaseConvention::Declared {
        version: 0,
        agree_value: built_for() as i16,
        contract_version: CONTRACT,
    };
    assert_eq!(judge(found, "coordinator", built_for()), Ok(()));
}

#[test]
fn no_table_names_the_migration_the_declare_command_and_the_guide() {
    let err = judge(DatabaseConvention::NoTable, "coordinator", built_for()).unwrap_err();
    assert!(matches!(err, Refusal::NotInstalled(_)));
    assert_eq!(err.token(), "vote_convention_not_installed");
    let m = err.message();
    assert!(m.starts_with("Polis cannot start (coordinator):"));
    assert!(m.contains("000025_vote_convention.sql"));
    assert!(m.contains(&declare_command(built_for())));
    assert!(m.contains("Nothing has been changed"));
    assert!(m.contains(&format!("{GUIDE}#guard")));
}

#[test]
fn no_row_names_the_exact_declare_command() {
    let err = judge(DatabaseConvention::NoRow, "coordinator", built_for()).unwrap_err();
    assert_eq!(err.token(), "vote_convention_undeclared");
    assert!(err.message().contains(&format!("\"{}\"", declare_command(built_for()))));
    assert!(err.message().contains(&format!("{GUIDE}#declare")));
}

#[test]
fn the_other_sign_refuses_because_this_build_would_invert_every_vote() {
    let found = DatabaseConvention::Declared {
        version: 1,
        agree_value: other() as i16,
        contract_version: CONTRACT,
    };
    let err = judge(found, "coordinator", built_for()).unwrap_err();
    assert_eq!(err.token(), "vote_convention_mismatch");
    assert!(err.message().contains("declares vote convention version 1"));
    assert!(err.message().contains("every vote inverted"));
    assert!(err.message().contains(&format!("{GUIDE}#mismatch")));
    // A build configured for the other sign accepts that declaration.
    assert_eq!(judge(found, "coordinator", other()), Ok(()));
}

#[test]
fn an_unknown_contract_refuses_before_the_sign_is_judged() {
    let found = DatabaseConvention::Declared {
        version: 0,
        agree_value: built_for() as i16,
        contract_version: CONTRACT + 1,
    };
    let err = judge(found, "coordinator", built_for()).unwrap_err();
    assert_eq!(err.token(), "vote_convention_contract_unsupported");
    assert!(err.message().contains(&format!("contract {}", CONTRACT + 1)));
    assert!(err.message().contains(&format!("{GUIDE}#a-newer-database")));
}

#[test]
fn the_declare_command_carries_the_sign() {
    assert_eq!(
        declare_command(built_for()),
        format!("make vote-convention-declare AGREE={:+}", built_for())
    );
    assert_eq!(
        declare_command(other()),
        format!("make vote-convention-declare AGREE={:+}", other())
    );
}

#[test]
fn the_display_form_carries_the_token_and_the_message() {
    let err = judge(DatabaseConvention::NoRow, "coordinator", built_for()).unwrap_err();
    let text = err.to_string();
    assert!(text.starts_with("vote_convention_undeclared: Polis cannot start"));
}
