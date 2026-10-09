//! Split only top-level SQL. Dollar bodies, quoted strings and comments are opaque.
//! This is deliberately not a general SQL rewriter: accept one optional outer
//! BEGIN/COMMIT pair and refuse every other transaction-control statement.
use anyhow::{Result, bail, ensure};

pub fn statements(sql: &str) -> Result<Vec<String>> {
    let b = sql.as_bytes();
    let (mut i, mut part, mut out) = (0, String::new(), Vec::new());
    while i < b.len() {
        let start = i;
        if b[i..].starts_with(b"--") {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            part.push(' ');
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
            continue;
        }
        if b[i] == b'\'' || b[i] == b'"' {
            let quote = b[i];
            let escaped = quote == b'\''
                && i > 0
                && matches!(b[i - 1], b'e' | b'E')
                && (i == 1 || !(b[i - 2].is_ascii_alphanumeric() || b[i - 2] == b'_'));
            i += 1;
            let mut closed = false;
            while i < b.len() {
                if escaped && b[i] == b'\\' {
                    i += 2;
                } else if b[i] == quote {
                    i += 1;
                    if i < b.len() && b[i] == quote {
                        i += 1;
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
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
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
        } else if b[i] == b';' {
            if !part.trim().is_empty() {
                out.push(part.trim().to_owned());
            }
            part.clear();
            i += 1;
            continue;
        } else {
            // Work at UTF-8 character boundaries even in unquoted identifiers.
            i += sql[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        }
        part.push_str(&sql[start..i]);
    }
    if !part.trim().is_empty() {
        out.push(part.trim().to_owned());
    }
    Ok(out)
}

pub fn body(sql: &str) -> Result<String> {
    let mut parts = statements(sql)?;
    ensure!(!parts.is_empty(), "empty migration");
    if parts[0].eq_ignore_ascii_case("BEGIN") {
        ensure!(
            parts
                .last()
                .is_some_and(|s| s.eq_ignore_ascii_case("COMMIT")),
            "BEGIN without final COMMIT"
        );
        parts.remove(0);
        parts.pop();
    }
    for part in &parts {
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
    Ok(parts.join(";\n") + ";")
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
}
