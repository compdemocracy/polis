//! The in-memory metrics collector is disabled; the public response is empty.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/perfStats_9182738127";
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Response {}
impl Request {
    pub const fn response(self) -> Response {
        Response {}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_collector_has_an_empty_object_contract() {
        assert_eq!(
            serde_json::to_string(&Request::default().response()).unwrap(),
            "{}"
        );
        assert!(serde_json::from_str::<Response>(r#"{"metric":1}"#).is_err());
    }
}
