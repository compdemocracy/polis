//! JSON Schema documents for the contracts, built the way the Node generator
//! builds them (server/src/contracts/generate.ts): the same keyword subset,
//! the same keyword order, the same layout. So a document rendered here can
//! be compared with the committed file byte for byte.
//!
//! [`render`] is the server and client-report copy (`JSON.stringify(document,
//! null, 2)` plus a newline). [`render_prettier`] is the
//! client-participation-alpha copy: prettier 2.8's JSON layout at print width
//! 100, which the Node generator applies to that client's files.
use crate::wire::{JsMap, Json};

/// One schema node. Only the keywords the generated contracts use.
#[derive(Clone, Debug, Default)]
pub struct Schema {
    root: Option<Root>,
    title: Option<&'static str>,
    description: Option<&'static str>,
    kind: Option<&'static str>,
    constant: Option<Json>,
    any_of: Option<Vec<Schema>>,
    properties: Option<Vec<(&'static str, Schema, bool)>>,
    pattern_properties: Option<Box<Schema>>,
    closed: bool,
    items: Option<Box<Schema>>,
    min_items: Option<u64>,
    max_items: Option<u64>,
    unique_items: bool,
    minimum: Option<i64>,
    min_length: Option<u64>,
    pattern: Option<&'static str>,
}

#[derive(Clone, Debug)]
struct Root {
    id: &'static str,
    comment: &'static str,
}

/// A property of [`object`]: required (always present) or optional.
pub struct Prop(&'static str, Schema, bool);
pub fn required(name: &'static str, schema: Schema) -> Prop {
    Prop(name, schema, true)
}
pub fn optional(name: &'static str, schema: Schema) -> Prop {
    Prop(name, schema, false)
}

fn typed(kind: &'static str) -> Schema {
    Schema {
        kind: Some(kind),
        ..Schema::default()
    }
}
pub fn string() -> Schema {
    typed("string")
}
pub fn integer() -> Schema {
    typed("integer")
}
pub fn number() -> Schema {
    typed("number")
}
pub fn boolean() -> Schema {
    typed("boolean")
}
pub fn null() -> Schema {
    typed("null")
}
/// TypeBox `Type.Literal("…")`.
pub fn literal(value: &'static str) -> Schema {
    Schema {
        constant: Some(Json::String(value.to_owned())),
        ..string()
    }
}
/// TypeBox `Type.Literal(true|false)`.
pub fn literal_bool(value: bool) -> Schema {
    Schema {
        constant: Some(Json::Bool(value)),
        ..boolean()
    }
}
/// TypeBox `Type.Literal(n)` for an exactly representable unsigned integer.
/// Every u32 is a finite JSON number, so the conversion cannot fail.
pub fn literal_u32(value: u32) -> Schema {
    Schema {
        constant: Some(Json::Number(crate::wire::JsNumber::from(value))),
        ..integer()
    }
}
pub fn array(items: Schema) -> Schema {
    Schema {
        items: Some(Box::new(items)),
        ..typed("array")
    }
}
/// TypeBox `Type.Record(Type.String(), value)`.
pub fn record(value: Schema) -> Schema {
    Schema {
        pattern_properties: Some(Box::new(value)),
        ..typed("object")
    }
}
pub fn union(branches: Vec<Schema>) -> Schema {
    Schema {
        any_of: Some(branches),
        ..Schema::default()
    }
}
/// TypeBox `Type.Object(props)`; `.strict()` adds `additionalProperties: false`.
pub fn object(props: Vec<Prop>) -> Schema {
    Schema {
        properties: Some(props.into_iter().map(|Prop(n, s, r)| (n, s, r)).collect()),
        ..typed("object")
    }
}
/// `Type.Union([schema, Type.Null()])`.
pub fn nullable(schema: Schema) -> Schema {
    union(vec![schema, null()])
}

impl Schema {
    pub fn title(mut self, title: &'static str) -> Self {
        self.title = Some(title);
        self
    }
    pub fn description(mut self, description: &'static str) -> Self {
        self.description = Some(description);
        self
    }
    pub fn strict(mut self) -> Self {
        self.closed = true;
        self
    }
    pub fn minimum(mut self, minimum: i64) -> Self {
        self.minimum = Some(minimum);
        self
    }
    pub fn min_length(mut self, min: u64) -> Self {
        self.min_length = Some(min);
        self
    }
    pub fn pattern(mut self, pattern: &'static str) -> Self {
        self.pattern = Some(pattern);
        self
    }
    pub fn min_items(mut self, min: u64) -> Self {
        self.min_items = Some(min);
        self
    }
    pub fn max_items(mut self, max: u64) -> Self {
        self.max_items = Some(max);
        self
    }
    pub fn unique(mut self) -> Self {
        self.unique_items = true;
        self
    }
    /// The document root: `$schema`, `$id` and the generator's `$comment`.
    pub fn document(mut self, id: &'static str, comment: &'static str) -> Self {
        self.root = Some(Root { id, comment });
        self
    }

    /// The node as JSON, keywords in generate.ts's `KEYWORD_ORDER`.
    pub fn to_json(&self) -> Json {
        let mut out = Vec::<(String, Json)>::new();
        let mut put = |key: &str, value: Json| out.push((key.to_owned(), value));
        let text = |s: &str| Json::String(s.to_owned());
        if let Some(root) = &self.root {
            put("$schema", text("http://json-schema.org/draft-07/schema#"));
            put("$id", text(root.id));
            put("$comment", text(root.comment));
        }
        if let Some(t) = self.title {
            put("title", text(t));
        }
        if let Some(d) = self.description {
            put("description", text(d));
        }
        if let Some(k) = self.kind {
            put("type", text(k));
        }
        if let Some(c) = &self.constant {
            put("const", c.clone());
        }
        if let Some(branches) = &self.any_of {
            put(
                "anyOf",
                Json::Array(branches.iter().map(Schema::to_json).collect()),
            );
        }
        if let Some(props) = &self.properties {
            let names: Vec<(String, Json)> = props
                .iter()
                .map(|(n, s, _)| ((*n).to_owned(), s.to_json()))
                .collect();
            put("properties", object_json(names));
            let required: Vec<Json> = props
                .iter()
                .filter(|(_, _, r)| *r)
                .map(|(n, _, _)| text(n))
                .collect();
            if !required.is_empty() {
                put("required", Json::Array(required));
            }
        }
        if let Some(value) = &self.pattern_properties {
            put(
                "patternProperties",
                object_json(vec![("^(.*)$".to_owned(), value.to_json())]),
            );
        }
        if self.closed {
            put("additionalProperties", Json::Bool(false));
        }
        if let Some(items) = &self.items {
            put("items", items.to_json());
        }
        if let Some(n) = self.min_items {
            put("minItems", Json::Number(n_json(n)));
        }
        if let Some(n) = self.max_items {
            put("maxItems", Json::Number(n_json(n)));
        }
        if self.unique_items {
            put("uniqueItems", Json::Bool(true));
        }
        if let Some(n) = self.minimum {
            put(
                "minimum",
                Json::Number(crate::wire::JsNumber::from(n as i32)),
            );
        }
        if let Some(n) = self.min_length {
            put("minLength", Json::Number(n_json(n)));
        }
        if let Some(p) = self.pattern {
            put("pattern", text(p));
        }
        object_json(out)
    }
}

fn n_json(n: u64) -> crate::wire::JsNumber {
    crate::wire::JsNumber::from(n as u32)
}

fn object_json(entries: Vec<(String, Json)>) -> Json {
    let mut map = JsMap::new();
    for (k, v) in entries {
        // Schema keywords and property names are never array indexes and
        // never repeat, so insertion order is kept and nothing is refused.
        let _ = map.insert(k, v);
    }
    Json::Object(map)
}

/// `JSON.stringify(document, null, 2) + "\n"`.
pub fn render(document: &Json) -> String {
    let mut text = crate::wire::to_json_pretty(document).unwrap_or_default();
    text.push('\n');
    text
}

// --- prettier 2.8 JSON layout ---------------------------------------------------------

/// The parts of prettier's document language a JSON value needs.
enum Doc {
    Text(String),
    /// A space when its group is flat, a newline when it breaks.
    Line,
    /// Nothing when its group is flat, a newline when it breaks.
    SoftLine,
    Concat(Vec<Doc>),
    Indent(Box<Doc>),
    Group {
        contents: Box<Doc>,
        broken: bool,
    },
}

/// `prettier.format(JSON.stringify(value), {parser: "json", printWidth: 100})`
/// for a value with no number arrays (prettier fills those; the schemas have
/// none, and such a value returns `None`).
pub fn render_prettier(value: &Json, width: usize) -> Option<String> {
    let mut doc = to_doc(value)?;
    propagate(&mut doc);
    let mut out = print(doc, width);
    out.push('\n');
    Some(out)
}

fn group(parts: Vec<Doc>, broken: bool) -> Doc {
    Doc::Group {
        contents: Box::new(Doc::Concat(parts)),
        broken,
    }
}

fn to_doc(value: &Json) -> Option<Doc> {
    Some(match value {
        Json::Object(map) if map.is_empty() => Doc::Text("{}".into()),
        Json::Object(map) => {
            // printObject: group(["{", indent([line, props joined by [",", line]]), line, "}"]),
            // each property group([group(key), ":", " ", value]) (never-break-after-operator).
            let mut inner = vec![Doc::Line];
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    inner.push(Doc::Text(",".into()));
                    inner.push(Doc::Line);
                }
                let key = crate::wire::to_json(k).ok()?;
                inner.push(group(
                    vec![
                        group(vec![Doc::Text(key)], false),
                        Doc::Text(": ".into()),
                        to_doc(v)?,
                    ],
                    false,
                ));
            }
            group(
                vec![
                    Doc::Text("{".into()),
                    Doc::Indent(Box::new(Doc::Concat(inner))),
                    Doc::Line,
                    Doc::Text("}".into()),
                ],
                false,
            )
        }
        Json::Array(items) if items.is_empty() => Doc::Text("[]".into()),
        Json::Array(items) => {
            if items.len() > 1 && items.iter().all(|i| matches!(i, Json::Number(_))) {
                return None;
            }
            // printArrayItems; the array breaks when it holds more than one
            // element and every element is an object (or every one an array)
            // with more than one entry.
            let broken = items.len() > 1
                && items.windows(2).all(|w| same_container(&w[0], &w[1]))
                && items.iter().all(|i| match i {
                    Json::Object(m) => m.len() > 1,
                    Json::Array(a) => a.len() > 1,
                    _ => false,
                });
            let mut inner = vec![Doc::SoftLine];
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    inner.push(Doc::Text(",".into()));
                    inner.push(Doc::Line);
                }
                inner.push(group(vec![to_doc(item)?], false));
            }
            group(
                vec![
                    Doc::Text("[".into()),
                    Doc::Indent(Box::new(Doc::Concat(inner))),
                    Doc::SoftLine,
                    Doc::Text("]".into()),
                ],
                broken,
            )
        }
        scalar => Doc::Text(crate::wire::to_json(scalar).ok()?),
    })
}

fn same_container(a: &Json, b: &Json) -> bool {
    matches!(
        (a, b),
        (Json::Object(_), Json::Object(_)) | (Json::Array(_), Json::Array(_))
    )
}

/// propagateBreaks: a group holding a broken group is broken.
fn propagate(doc: &mut Doc) -> bool {
    match doc {
        Doc::Text(_) | Doc::Line | Doc::SoftLine => false,
        Doc::Concat(parts) => parts.iter_mut().fold(false, |acc, p| propagate(p) | acc),
        Doc::Indent(inner) => propagate(inner),
        Doc::Group { contents, broken } => {
            let inner = propagate(contents);
            *broken |= inner;
            *broken
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Flat,
    Break,
}

/// printDocToString, for the parts above.
fn print(doc: Doc, width: usize) -> String {
    let mut out = String::new();
    let mut pos = 0usize;
    let mut cmds: Vec<(usize, Mode, &Doc)> = vec![(0, Mode::Break, &doc)];
    while let Some((indent, mode, doc)) = cmds.pop() {
        match doc {
            Doc::Text(s) => {
                out.push_str(s);
                pos += s.chars().count();
            }
            Doc::Concat(parts) => {
                for p in parts.iter().rev() {
                    cmds.push((indent, mode, p));
                }
            }
            Doc::Indent(inner) => cmds.push((indent + 2, mode, inner)),
            Doc::Group { contents, broken } => {
                let flat = match mode {
                    Mode::Flat => !*broken,
                    Mode::Break => !*broken && fits(contents, &cmds, width as isize - pos as isize),
                };
                cmds.push((
                    indent,
                    if flat { Mode::Flat } else { Mode::Break },
                    contents,
                ));
            }
            Doc::Line | Doc::SoftLine => match mode {
                Mode::Flat => {
                    if matches!(doc, Doc::Line) {
                        out.push(' ');
                        pos += 1;
                    }
                }
                Mode::Break => {
                    while out.ends_with(' ') {
                        out.pop();
                    }
                    out.push('\n');
                    out.push_str(&" ".repeat(indent));
                    pos = indent;
                }
            },
        }
    }
    out
}

/// fits: the group's contents printed flat, then the rest in their own modes,
/// up to the first line in break mode, within the remaining width.
fn fits(next: &Doc, rest: &[(usize, Mode, &Doc)], mut width: isize) -> bool {
    let mut rest_index = rest.len();
    let mut cmds: Vec<(Mode, &Doc)> = vec![(Mode::Flat, next)];
    while width >= 0 {
        let Some((mode, doc)) = cmds.pop() else {
            if rest_index == 0 {
                return true;
            }
            rest_index -= 1;
            let (_, mode, doc) = rest[rest_index];
            cmds.push((mode, doc));
            continue;
        };
        match doc {
            Doc::Text(s) => width -= s.chars().count() as isize,
            Doc::Concat(parts) => {
                for p in parts.iter().rev() {
                    cmds.push((mode, p));
                }
            }
            Doc::Indent(inner) => cmds.push((mode, inner)),
            Doc::Group { contents, broken } => {
                cmds.push((if *broken { Mode::Break } else { mode }, contents));
            }
            Doc::Line | Doc::SoftLine => {
                if mode == Mode::Break {
                    return true;
                }
                if matches!(doc, Doc::Line) {
                    width -= 1;
                }
            }
        }
    }
    false
}
