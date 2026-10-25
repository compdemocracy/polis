//! Conversation link HTML as emitted by the existing public page handlers.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Page {
    Participation,
    Moderation,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub page: Page,
    pub conversation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub html: String,
}
impl Response {
    pub fn participation(cid: &str) -> Self {
        Self {
            html: format!("<a href='https://pol.is/{cid}' target='_blank'>{cid}</a>"),
        }
    }
    // The source sends these strings verbatim, including markup. Escaping them
    // would change the public response and belongs to a separate change.
    pub fn moderation(cid: &str, title: &str, description: Option<&str>) -> Self {
        let mut html = format!(
            "<a href='https://pol.is/{cid}' target='_blank'>{title}</a><p><a href='https://pol.is/m{cid}' target='_blank'>moderate</a></p>"
        );
        if let Some(description) = description.filter(|s| !s.is_empty()) {
            html.push_str(&format!("<p>{description}</p>"));
        }
        Self { html }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markup_and_empty_description_are_preserved() {
        assert_eq!(
            Response::participation("4fixture").html,
            "<a href='https://pol.is/4fixture' target='_blank'>4fixture</a>"
        );
        assert_eq!(
            Response::moderation("4fixture", "<b>topic</b>", Some("")),
            Response::moderation("4fixture", "<b>topic</b>", None)
        );
        assert!(
            Response::moderation("4fixture", "1700000000000", Some("🙂 & <em>text</em>"))
                .html
                .ends_with("<p>🙂 & <em>text</em></p>")
        );
    }
    #[test]
    fn unchanged_node_recordings_match_html_contract() {
        #[derive(Deserialize)]
        struct Recorded {
            page: Page,
            conversation_id: String,
            html: String,
        }
        let rows: Vec<Recorded> =
            serde_json::from_str(include_str!("fixtures/link-pages.json")).unwrap();
        assert_eq!(rows.len(), 11);
        for row in rows {
            let response = match row.page {
                Page::Participation => Response::participation(&row.conversation_id),
                Page::Moderation => {
                    let (title, description) = match row.conversation_id.as_str() {
                        "4linkplain" => ("Generated topic", Some("Generated description")),
                        "4linkempty" => ("1700000000000", None),
                        "4linkmarkup" => ("<b>Topic & 🙂</b>", Some("<em>raw markup</em>")),
                        "4linknull" => ("null", Some("")),
                        "4linkbigint" => ("9223372036854775807", None),
                        _ => panic!("unexpected fixture"),
                    };
                    Response::moderation(&row.conversation_id, title, description)
                }
            };
            assert_eq!(response.html, row.html, "{}", row.conversation_id);
        }
    }
}
