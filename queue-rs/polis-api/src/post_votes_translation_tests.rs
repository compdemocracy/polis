use super::{
    database::{Database, actor},
    *,
};

const TWO_ROWS: &str = r#"[{"zid":1,"tid":0,"src":23,"txt":"Bonjour 🌍","lang":"fr","created":"9007199254740993","modified":null},{"zid":1,"tid":0,"src":-1,"txt":"Hallo \"Welt\"","lang":"de","created":"12","modified":"13"}]"#;

fn fixture(label: &str) -> Database {
    let db = Database::new(label);
    db.connect().batch_execute(
        "INSERT INTO users(uid) VALUES(1);
         INSERT INTO conversations(zid,is_active,modified) VALUES(1,true,0);
         ALTER TABLE participants DISABLE TRIGGER USER;
         INSERT INTO participants(zid,pid,uid) VALUES(1,0,1);
         ALTER TABLE participants ENABLE TRIGGER USER;
         INSERT INTO comments(zid,pid,uid,txt,lang,created) VALUES(1,0,1,'Generated statement','en',10);"
    ).unwrap();
    db
}

fn stored_rows(db: &Database) {
    db.connect()
        .batch_execute(
            "INSERT INTO comment_translations(zid,tid,src,txt,lang,created,modified) VALUES
         (1,0,23,'Bonjour 🌍','fr',9007199254740993,NULL),
         (1,0,-1,'Hallo \"Welt\"','de',12,13),
         (1,99,23,'Other statement','fr',14,15);",
        )
        .unwrap();
}

fn translations(db: &Database, lang: Option<&str>) -> String {
    let complete = complete(&mut db.connect(), &actor(), "test", 0.5, lang).unwrap();
    let encoded = serde_json::to_string(&complete).unwrap();
    let next = complete.next_comment.unwrap();
    let raw = serde_json::to_string(&next).unwrap();
    assert!(
        encoded.contains(&raw),
        "raw next-comment order survives the contract"
    );
    // Compare the actual RawValue bytes, without a Value reserialization that
    // could reorder object properties or lose bigint precision.
    let start = raw.find("\"translations\":").unwrap() + "\"translations\":".len();
    raw[start..raw.len() - 1].to_owned()
}

#[test]
fn stored_translation_empty_is_nodes_empty_array() {
    let db = fixture("translations_empty");
    assert_eq!(translations(&db, Some("fr")), "[]");
}

#[test]
fn stored_translation_two_languages_preserve_node_bytes_and_order() {
    let db = fixture("translations_rows");
    stored_rows(&db);
    assert_eq!(translations(&db, Some("es")), TWO_ROWS);
}

#[test]
fn stored_translation_human_row_survives_without_a_provider() {
    let db = fixture("translations_human");
    stored_rows(&db);
    db.connect()
        .batch_execute("DELETE FROM comment_translations WHERE src < 0")
        .unwrap();
    let expected = TWO_ROWS.split(",{\"zid\"").next().unwrap().to_owned() + "]";
    assert_eq!(translations(&db, Some("fr")), expected);
}

#[test]
fn stored_translation_same_source_language_still_returns_every_row() {
    let db = fixture("translations_same");
    stored_rows(&db);
    assert_eq!(translations(&db, Some("EN-gb")), TWO_ROWS);
}

#[test]
fn stored_translation_no_language_never_reads_the_table() {
    let db = fixture("translations_no_lang");
    stored_rows(&db);
    assert_eq!(translations(&db, None), "[]");
    assert_eq!(translations(&db, Some("")), "[]");
    db.connect()
        .batch_execute("DROP TABLE comment_translations")
        .unwrap();
    assert_eq!(translations(&db, None), "[]");
    assert_eq!(translations(&db, Some("")), "[]");
}

#[test]
fn stored_translation_read_failure_keeps_the_statement() {
    let db = fixture("translations_failure");
    db.connect()
        .batch_execute("DROP TABLE comment_translations")
        .unwrap();
    assert_eq!(translations(&db, Some("fr")), "[]");
}

#[test]
fn stored_translation_exhaustion_omits_next_comment() {
    let db = fixture("translations_exhausted");
    db.connect()
        .batch_execute("UPDATE comments SET active=false; DROP TABLE comment_translations")
        .unwrap();
    let result = complete(&mut db.connect(), &actor(), "test", 0.5, Some("fr")).unwrap();
    assert_eq!(
        serde_json::to_string(&result).unwrap(),
        r#"{"currentPid":0}"#
    );
}

pub(super) fn stored_node_rows() -> &'static str {
    TWO_ROWS
}
