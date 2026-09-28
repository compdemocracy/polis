fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var_os("CARGO_FEATURE_FAULT_INJECTION").is_some()
    {
        panic!("fault-injection is forbidden in release builds");
    }
}
