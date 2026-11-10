//! UTC times: the window's bounds on the command line, and CloudWatch's
//! datapoint timestamps.
use anyhow::{Context, Result, bail};

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn number(text: &str, what: &str) -> Result<i64> {
    text.parse::<i64>()
        .with_context(|| format!("{what} is not a number: {text}"))
}

/// Seconds since the epoch, from `YYYY-MM-DDTHH:MM:SS` followed by `Z`,
/// `+00:00` or another offset, optionally with fractional seconds; or from a
/// plain integer of seconds.
pub fn parse(text: &str) -> Result<i64> {
    if !text.is_ascii() {
        bail!("not a UTC time: {text}");
    }
    if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) {
        return number(text, "time");
    }
    let bytes = text.as_bytes();
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        bail!("not a UTC time (YYYY-MM-DDTHH:MM:SSZ): {text}");
    }
    let y = number(&text[0..4], "year")?;
    let mo = number(&text[5..7], "month")?;
    let d = number(&text[8..10], "day")?;
    let h = number(&text[11..13], "hour")?;
    let mi = number(&text[14..16], "minute")?;
    let s = number(&text[17..19], "second")?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        bail!("not a valid time: {text}");
    }
    let mut rest = &text[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        rest = &fraction[digits..];
    }
    let offset = match rest {
        "Z" | "" | "+00:00" => 0,
        _ if rest.len() == 6 && matches!(&rest[0..1], "+" | "-") && &rest[3..4] == ":" => {
            let sign = if &rest[0..1] == "-" { -1 } else { 1 };
            sign * (number(&rest[1..3], "offset")? * 3600 + number(&rest[4..6], "offset")? * 60)
        }
        _ => bail!("not a valid time offset: {text}"),
    };
    Ok(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s - offset)
}

/// `YYYY-MM-DDTHH:MM:SSZ`.
pub fn format(epoch_s: i64) -> String {
    let (y, m, d) = civil_from_days(epoch_s.div_euclid(86_400));
    let rem = epoch_s.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}
