//! Assembles the standalone page: a template with `{{{NAME}}}` slots, each
//! filled with the text of a file (script, style, data) or with a file's bytes
//! in base64 (the typeface). The result is one HTML file that fetches nothing.

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Text that is safe between `<script>` and `</script>`: no `</` can end the
/// element early and no `<!--` can open a comment.
pub fn script_safe(text: &str) -> String {
    text.replace("</", "<\\/").replace("<!--", "<\\!--")
}

/// Fills every slot in one pass over the template, so text that is put in is
/// never itself searched for slots. A slot with no value is an error.
pub fn fill(template: &str, slots: &[(String, String)]) -> Result<String, String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    let mut used = vec![false; slots.len()];
    while let Some(at) = rest.find("{{{") {
        out.push_str(&rest[..at]);
        let end = rest[at..]
            .find("}}}")
            .ok_or("a slot is opened with {{{ and never closed")?;
        let name = &rest[at + 3..at + end];
        let k = slots
            .iter()
            .position(|(n, _)| n == name)
            .ok_or_else(|| format!("no value for slot {{{{{{{name}}}}}}}"))?;
        used[k] = true;
        out.push_str(&slots[k].1);
        rest = &rest[at + end + 3..];
    }
    out.push_str(rest);
    if let Some(k) = used.iter().position(|u| !u) {
        return Err(format!(
            "the template has no slot {{{{{{{}}}}}}}",
            slots[k].0
        ));
    }
    Ok(out)
}
