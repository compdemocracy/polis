//! Participant-owned CSV, including the distinct header-only newline shapes.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/treevite/myInvites/csv";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub conversation_id: String,
    pub csv: String,
}
pub fn escape(s: &str) -> String {
    let escaped = s.replace('"', "\"\"");
    if s.contains([',', '"', '\n']) {
        format!("\"{escaped}\"")
    } else {
        escaped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unchanged_node_csv_shapes_and_escape_bytes() {
        #[derive(Deserialize)]
        struct Fixture {
            id: String,
            csv: String,
        }
        let fixtures: Vec<Fixture> =
            serde_json::from_str(include_str!("fixtures/my-invites-csv.json")).unwrap();
        for fixture in fixtures {
            let expected = if fixture.id.starts_with("populated/") {
                format!(
                    "invite_code,status,created_at\ngenerated invite,unused,Sat Feb 29 2020\n{},unused,Sat Feb 29 2020\ncarriage\rreturn,unused,\nunicode 🙂,unused,Sat Feb 29 2020",
                    escape("comma,quote\"line\nnext")
                )
            } else if fixture.id.contains("/owner") {
                "invite_code,status,created_at\n".into()
            } else {
                "invite_code,status,created_at".into()
            };
            assert_eq!(fixture.csv, expected, "{}", fixture.id);
        }
    }
}
