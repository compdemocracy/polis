//! Current bucket membership and the locations in one group.
use serde::{Deserialize, Serialize};
pub const BID_PATH: &str = "/api/v3/bid";
pub const LOCATIONS_PATH: &str = "/api/v3/locations";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind {
    Bid,
    Locations,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub kind: Kind,
    pub conversation_id: String,
    pub math_tick: i32,
    pub gid: Option<i32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bid {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bid: Option<i32>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Location {
    pub lat: crate::wire::JsNumber,
    pub lng: crate::wire::JsNumber,
    pub n: i32,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unchanged_node_bucket_and_location_bytes() {
        #[derive(Deserialize)]
        struct Fixture {
            id: String,
            kind: String,
            body: String,
        }
        let fixtures: Vec<Fixture> =
            serde_json::from_str(include_str!("fixtures/math-membership.json")).unwrap();
        for f in fixtures {
            let encoded = if f.kind == "bid" {
                serde_json::to_string(&serde_json::from_str::<Bid>(&f.body).unwrap()).unwrap()
            } else {
                serde_json::to_string(&serde_json::from_str::<Vec<Location>>(&f.body).unwrap())
                    .unwrap()
            };
            assert_eq!(encoded, f.body, "{}", f.id);
        }
    }
}
