//! The counted input tokens compared with the cap are the body's UTF-8 bytes:
//! at least every byte of text the provider tokenizes, in any script, plus the
//! body's own JSON.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use polis_topic_names::{Hierarchy, RunCap, name_topics, prompt::body_v1};
use support::{fixture, hierarchy, namer, settings};

/// The UTF-8 bytes of every string in a JSON value: all the text the provider
/// could tokenize from the body.
fn text_bytes(v: &serde_json::Value) -> usize {
    match v {
        serde_json::Value::String(s) => s.len(),
        serde_json::Value::Array(a) => a.iter().map(text_bytes).sum(),
        serde_json::Value::Object(m) => m.iter().map(|(k, x)| k.len() + text_bytes(x)).sum(),
        _ => 0,
    }
}

fn assert_counted_bounds_the_text(h: &Hierarchy, what: &str) {
    for (model, thinking) in [("haiku", "default"), ("sonnet", "off")] {
        let n = namer(model, thinking);
        let body = body_v1(h, &n);
        let text = text_bytes(&serde_json::from_str(&body).unwrap());
        // The counted figure is the body's bytes, and it is more than every
        // byte of text in it by at least the body's own JSON.
        assert!(
            body.len() >= text + 100,
            "{what}: {} < {text} + 100",
            body.len()
        );
        let file = name_topics(
            h,
            &n,
            None,
            RunCap::Usd(10.0),
            &settings("http://127.0.0.1:9/v1"),
        );
        let expected = n.model.worst_case_usd(body.len() as u64, 32_000);
        assert!(
            (file.record.worst_case_usd - expected).abs() < 1e-12,
            "{what}"
        );
        assert_eq!(file.outcome, "no_key");
    }
}

#[test]
fn the_fixtures_non_latin_text_is_counted_by_its_bytes() {
    for conv in ["vtaiwan", "mobilitaet"] {
        let h = hierarchy(conv);
        let body = body_v1(&h, &namer("sonnet", "default"));
        let multibyte: usize = body.chars().filter(|c| c.len_utf8() > 1).count();
        let three_byte: usize = body.chars().filter(|c| c.len_utf8() >= 3).count();
        assert!(multibyte > 0, "{conv}");
        // Every Han character counts as three tokens, every umlaut as two.
        assert!(
            body.len() >= body.chars().count() + multibyte + three_byte,
            "{conv}"
        );
        assert_counted_bounds_the_text(&h, conv);
    }
}

#[test]
fn text_in_any_script_is_counted_by_its_bytes() {
    let samples = [
        "공공 교통은 더 편리해야 합니다.",
        "يجب أن تكون المواصلات العامة أكثر راحة.",
        "सार्वजनिक परिवहन अधिक सुविधाजनक होना चाहिए।",
        "การขนส่งสาธารณะควรสะดวกกว่านี้",
        "Общественный транспорт должен быть удобнее.",
        "公共交通は もっと便利で あるべきです。",
        "𠜎𠜱𠝹𠱓 𩷶𩸽 𪚥𪆷",
        "👩🏽‍🚒👨‍👩‍👧‍👦 🏳️‍🌈",
        "e\u{301}\u{302}\u{303} a\u{30a}\u{327}",
        "\u{200b}\u{feff}\u{2060} \u{e000}\u{10fffd}",
    ];
    let mut h: serde_json::Value =
        serde_json::from_str(&fixture("hierarchies/vtaiwan.json")).unwrap();
    for (i, t) in h["topics"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .enumerate()
    {
        let s = samples[i % samples.len()];
        t["samples3"] = serde_json::json!([s, s, s]);
        t["keywords"] = serde_json::json!([s]);
    }
    let h = Hierarchy::from_json(&h.to_string()).unwrap();
    let body = body_v1(&h, &namer("sonnet", "default"));
    // Four-byte characters count as four tokens, where characters counted one.
    let four: usize = body.chars().filter(|c| c.len_utf8() == 4).count();
    assert!(four > 0);
    assert!(body.len() >= body.chars().count() + 3 * four);
    assert_counted_bounds_the_text(&h, "scripts");
}

#[test]
fn the_recorded_input_tokens_are_under_the_count() {
    for (request, replies) in [
        ("requests/bg2050-haiku-default.json", "haiku-default"),
        ("requests/bg2050-sonnet-off.json", "sonnet-off"),
    ] {
        let bytes = fixture(request).len() as u64;
        for r in 1..=3 {
            let reply: serde_json::Value =
                serde_json::from_str(&fixture(&format!("replies/bg2050/{replies}-r{r}.json")))
                    .unwrap();
            let u = &reply["usage"];
            let prompt = u["input_tokens"].as_u64().unwrap()
                + u["cache_creation_input_tokens"].as_u64().unwrap_or(0)
                + u["cache_read_input_tokens"].as_u64().unwrap_or(0);
            assert!(
                prompt > 0 && prompt <= bytes,
                "{replies}-r{r}: {prompt} > {bytes}"
            );
        }
    }
}
