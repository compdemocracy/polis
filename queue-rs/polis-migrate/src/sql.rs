//! Split only top-level SQL. Dollar bodies, quoted strings and comments are opaque.
//! This is deliberately not a general SQL rewriter: accept one optional outer
//! BEGIN/COMMIT pair and refuse every other transaction-control statement.
use anyhow::{Result, bail, ensure};

fn ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || !c.is_ascii()
}

fn ident_continue(c: char) -> bool {
    ident_start(c) || c.is_ascii_digit() || c == '$'
}

// PostgreSQL continues single-quoted strings across whitespace containing a
// newline, retaining the first segment's E-string escape mode. Line comments
// count as whitespace here; block comments terminate this lexical construct.
fn continued_string(bytes: &[u8], mut next: usize) -> Option<usize> {
    let mut newline = false;
    while next < bytes.len() {
        match bytes[next] {
            b'\n' | b'\r' => {
                newline = true;
                next += 1;
            }
            b' ' | b'\t' | b'\x0c' | b'\x0b' => next += 1,
            b'-' if bytes[next..].starts_with(b"--") => {
                while next < bytes.len() && !matches!(bytes[next], b'\n' | b'\r') {
                    next += 1;
                }
            }
            b'\'' if newline => return Some(next + 1),
            _ => return None,
        }
    }
    None
}

// Keep executable bytes alongside comment-free text used only for inspection.
// Removing comments from the executed source can change string-literal parsing.
fn lex(sql: &str) -> Result<Vec<(String, String)>> {
    let b = sql.as_bytes();
    let (mut i, mut part, mut raw, mut out) = (0, String::new(), String::new(), Vec::new());
    while i < b.len() {
        let start = i;
        if b[i..].starts_with(b"--") {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            part.push(' ');
            raw.push_str(&sql[start..i]);
            continue;
        }
        if b[i..].starts_with(b"/*") {
            let mut depth = 1;
            i += 2;
            while i < b.len() && depth > 0 {
                if b[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if b[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            ensure!(depth == 0, "unterminated SQL comment");
            part.push(' ');
            raw.push_str(&sql[start..i]);
            continue;
        }
        if b[i] == b'\'' || b[i] == b'"' {
            let quote = b[i];
            let escaped = quote == b'\''
                && i > 0
                && matches!(b[i - 1], b'e' | b'E')
                && (i == 1 || !sql[..i - 1].chars().next_back().is_some_and(ident_continue));
            i += 1;
            let mut closed = false;
            while i < b.len() {
                if escaped && b[i] == b'\\' {
                    i += 2;
                } else if b[i] == quote {
                    i += 1;
                    if i < b.len() && b[i] == quote {
                        i += 1;
                    } else if quote == b'\''
                        && let Some(next) = continued_string(b, i)
                    {
                        i = next;
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            ensure!(closed && i <= b.len(), "unterminated SQL quote");
        } else if b[i] == b'$' {
            let mut j = i + 1;
            for c in sql[j..].chars() {
                if ident_start(c) || (j > i + 1 && c.is_ascii_digit()) {
                    j += c.len_utf8();
                } else {
                    break;
                }
            }
            if j < b.len() && b[j] == b'$' {
                let tag = &sql[i..=j];
                let rest = &sql[j + 1..];
                let end = rest
                    .find(tag)
                    .ok_or_else(|| anyhow::anyhow!("unterminated dollar body"))?;
                i = j + 1 + end + tag.len();
            } else {
                i += 1;
            }
        } else if sql[i..].chars().next().is_some_and(ident_start) {
            // '$' is legal inside an unquoted identifier. Consume the whole
            // identifier before looking for a dollar-quoted body; PostgreSQL
            // requires a delimiter between an identifier and such a body.
            for c in sql[i..].chars() {
                if !ident_continue(c) {
                    break;
                }
                i += c.len_utf8();
            }
        } else if b[i] == b';' {
            if !part.trim().is_empty() {
                out.push((part.trim().to_owned(), raw.trim_start().to_owned()));
            }
            part.clear();
            raw.clear();
            i += 1;
            continue;
        } else {
            // Work at UTF-8 character boundaries even in unquoted identifiers.
            i += sql[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        }
        part.push_str(&sql[start..i]);
        raw.push_str(&sql[start..i]);
    }
    if !part.trim().is_empty() {
        out.push((part.trim().to_owned(), raw.trim_start().to_owned()));
    }
    Ok(out)
}

pub fn statements(sql: &str) -> Result<Vec<String>> {
    Ok(lex(sql)?
        .into_iter()
        .map(|(inspection, _)| inspection)
        .collect())
}

pub fn body(sql: &str) -> Result<String> {
    let mut parts = lex(sql)?;
    ensure!(!parts.is_empty(), "empty migration");
    if parts[0].0.eq_ignore_ascii_case("BEGIN") {
        ensure!(
            parts
                .last()
                .is_some_and(|s| s.0.eq_ignore_ascii_case("COMMIT")),
            "BEGIN without final COMMIT"
        );
        parts.remove(0);
        parts.pop();
    }
    for (part, _) in &parts {
        let first = part
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        if matches!(
            first.as_str(),
            "BEGIN"
                | "START"
                | "COMMIT"
                | "END"
                | "ROLLBACK"
                | "ABORT"
                | "SAVEPOINT"
                | "RELEASE"
                | "PREPARE"
        ) || first.starts_with('\\')
        {
            bail!("migration contains transaction control or a psql command: {first}");
        }
    }
    Ok(parts
        .into_iter()
        .map(|(_, raw)| raw)
        .collect::<Vec<_>>()
        .join(";\n")
        + ";")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dollar_and_comment_bodies() -> Result<()> {
        let s = "-- BEGIN;\nBEGIN; DO $q$ BEGIN RAISE NOTICE 'COMMIT;'; END $q$; /* a /* b */ c */ COMMIT;";
        assert_eq!(body(s)?, "DO $q$ BEGIN RAISE NOTICE 'COMMIT;'; END $q$;");
        Ok(())
    }
    #[test]
    fn nested_control_refused() {
        for s in [
            "BEGIN; SELECT 1; COMMIT; COMMIT;",
            "SELECT 1; ROLLBACK;",
            "START TRANSACTION; SELECT 1;",
            "BEGIN; SELECT 1;",
            "SELECT 1; \\i file",
        ] {
            assert!(body(s).is_err(), "{s}");
        }
    }
    #[test]
    fn quotes_and_unicode() -> Result<()> {
        assert_eq!(
            statements("SELECT E'a\\';b', 'c'';d', \"é;\"; SELECT '𝄞';")?.len(),
            2
        );
        Ok(())
    }
    #[test]
    fn incomplete_refused() {
        for s in ["SELECT 'x", "DO $$ x", "/* unclosed", "-- empty"] {
            assert!(body(s).is_err());
        }
    }
    #[test]
    fn dollar_identifiers_do_not_quote_following_statements() -> Result<()> {
        let source =
            "CREATE TABLE a$tag$ (x int); COMMIT; CREATE TABLE b$tag$ (y int); SELECT 1/0;";
        assert_eq!(statements(source)?.len(), 4);
        assert!(body(source).is_err());
        assert!(body("CREATE TABLE é$tag$ (x int); COMMIT; CREATE TABLE z$tag$ (y int);").is_err());
        assert_eq!(
            statements("SELECT ordinary$identifier, other$$identifier;")?.len(),
            1
        );
        Ok(())
    }
    #[test]
    fn unicode_dollar_tags_preserve_function_bodies() -> Result<()> {
        let source = "DO $тег_1$ BEGIN PERFORM 1; END $тег_1$; SELECT 2;";
        assert_eq!(statements(source)?.len(), 2);
        assert!(body(source)?.contains("BEGIN PERFORM 1; END"));
        Ok(())
    }
    #[test]
    fn executable_comments_are_preserved() -> Result<()> {
        let source = "SELECT 'a' /* line\n /* nested */ end */ 'b';";
        assert_eq!(body(source)?, source);
        assert!(body("BEGIN; SELECT 1; COMMIT/* trailing */;")?.contains("SELECT 1"));
        assert!(body("SELECT 1; COMMIT/* trailing */;").is_err());
        Ok(())
    }
    #[test]
    fn escaped_string_continuations_keep_their_mode() -> Result<()> {
        let source = "SELECT E'a' -- explanation\n'b\\'c'; SELECT 2;";
        assert_eq!(statements(source)?.len(), 2);
        assert!(body(source)?.contains("'b\\'c'"));
        Ok(())
    }
    #[test]
    fn typed_literals_after_identifiers_use_ordinary_string_mode() -> Result<()> {
        // E is a prefix only at a token boundary. Dollar and non-ASCII characters
        // are PostgreSQL identifier continuations too; use the same rule above.
        for name in ["typed$E", "typedéE", "typedeE"] {
            let source = format!("SELECT {name}'a\\'; SELECT 2;");
            assert_eq!(statements(&source)?.len(), 2, "{name}");
            assert!(body(&source).is_ok(), "{name}");
        }
        assert_eq!(statements("SELECT E'a\\\\'; SELECT 2;")?.len(), 2);
        Ok(())
    }
}
