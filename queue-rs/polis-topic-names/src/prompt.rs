//! Prompt version 1 and the request body.
//!
//! The instruction, the topic lines, the schema and the body's layout are the
//! ones the 2026-11-22 measurement sent for its whole-hierarchy call, byte for
//! byte, with one sentence added (the language sentence). The body is written
//! the way that measurement wrote it (Python's `json.dumps` with
//! `ensure_ascii=False`: `", "` and `": "` separators, keys in the order
//! below), so a test can compare it with a saved body.

use crate::hierarchy::{Hierarchy, MAX_KEYWORDS, MAX_SAMPLES};
use crate::namer::{Namer, Thinking};
use std::fmt::Write as _;

/// The instruction up to and including the sentence the language sentence
/// follows.
pub const INSTRUCTION_HEAD: &str = "The comments of one conversation have been grouped into topics, in layers. Layer 0 holds the narrowest topics; each higher layer holds broader topics, and a topic's parent is the broader topic in the layer above that contains it. Below, every topic is listed, broadest layer first, with its id, its layer, its parent's id, its number of comments, its five keywords and up to three sample comments.\n\nGive every topic a short name (3\u{2013}5 words) that says what its comments are about. Name each topic exactly once, by its id. No two topics may share a name.";

/// The one sentence version 1 adds, after a single space.
pub const LANGUAGE_SENTENCE: &str =
    "Write every name in the language most of these comments are written in.";

/// The rest of the instruction, before the topic lines.
pub const INSTRUCTION_TAIL: &str = "\n\nTopics:\n";

/// `max_tokens` of every call.
pub const MAX_TOKENS: u64 = 32_000;

/// The JSON schema of the reply, as the measurement sent it
/// (`output_config.format`), in its serialized form.
pub const REPLY_FORMAT: &str = r#"{"type": "json_schema", "schema": {"type": "object", "additionalProperties": false, "required": ["topics"], "properties": {"topics": {"type": "array", "items": {"type": "object", "additionalProperties": false, "required": ["id", "name"], "properties": {"id": {"type": "string"}, "name": {"type": "string"}}}}}}}"#;

/// Version 1's instruction.
pub fn instruction_v1() -> String {
    format!("{INSTRUCTION_HEAD} {LANGUAGE_SENTENCE}{INSTRUCTION_TAIL}")
}

/// The measurement's instruction, without the language sentence.
pub fn instruction_measured() -> String {
    format!("{INSTRUCTION_HEAD}{INSTRUCTION_TAIL}")
}

/// The topic lines: one line per topic, broadest layer first, each followed by
/// its numbered sample comments.
pub fn hierarchy_text(h: &Hierarchy) -> String {
    let mut out = String::new();
    for t in h.topics() {
        let keywords: Vec<&str> = t
            .keywords
            .iter()
            .take(MAX_KEYWORDS)
            .map(String::as_str)
            .collect();
        let _ = writeln!(
            out,
            "{} | layer {} | parent: {} | {} comments | keywords: {}",
            t.id,
            t.layer,
            t.parent
                .as_deref()
                .filter(|p| !p.is_empty())
                .unwrap_or("none"),
            t.size,
            keywords.join(", ")
        );
        for (j, s) in t.samples3.iter().take(MAX_SAMPLES).enumerate() {
            let _ = writeln!(out, "   {}. {}", j + 1, s);
        }
    }
    out
}

/// The request body for an instruction.
pub fn body_with_instruction(h: &Hierarchy, namer: &Namer, instruction: &str) -> String {
    let mut content = String::from(instruction);
    content.push_str(&hierarchy_text(h));
    let mut body = String::from("{\"model\": ");
    // The provider's id for the model: `claude-sonnet-5-5` on the Claude API,
    // `anthropic.claude-sonnet-5-5` on Bedrock. Nothing else in the body
    // depends on the provider.
    push_json_string(&mut body, namer.request_model_id());
    let _ = write!(
        body,
        ", \"max_tokens\": {MAX_TOKENS}, \"messages\": [{{\"role\": \"user\", \"content\": "
    );
    push_json_string(&mut body, &content);
    body.push_str("}]");
    if namer.thinking == Thinking::Off {
        body.push_str(", \"thinking\": {\"type\": ");
        push_json_string(&mut body, namer.model.thinking_off_type());
        body.push('}');
    }
    body.push_str(", \"output_config\": {\"format\": ");
    body.push_str(REPLY_FORMAT);
    body.push_str("}}");
    body
}

/// Version 1's request body.
pub fn body_v1(h: &Hierarchy, namer: &Namer) -> String {
    body_with_instruction(h, namer, &instruction_v1())
}

/// Writes a JSON string as Python's `json.dumps(..., ensure_ascii=False)`
/// does: `"` and `\` escaped, the five short control escapes, every other
/// control character below U+0020 as `\u00xx`, everything else as itself.
pub fn push_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn json_strings_escape_as_python_does() {
        let mut s = String::new();
        push_json_string(&mut s, "a\"b\\c\nd\te\u{1}f\u{7f}g\u{e9}\u{8a08}\u{2028}");
        assert_eq!(
            s,
            "\"a\\\"b\\\\c\\nd\\te\\u0001f\u{7f}g\u{e9}\u{8a08}\u{2028}\""
        );
    }

    #[test]
    fn the_schema_is_valid_json_and_reserializes_the_same_way() {
        let v: serde_json::Value = serde_json::from_str(REPLY_FORMAT).unwrap();
        let compact = serde_json::to_string(&v).unwrap();
        // The schema's objects are written in a fixed order; serde_json's map
        // here is sorted, so compare the content, not the order.
        assert_eq!(
            v,
            serde_json::from_str::<serde_json::Value>(&compact).unwrap()
        );
        assert_eq!(v["schema"]["required"][0], "topics");
    }
}
