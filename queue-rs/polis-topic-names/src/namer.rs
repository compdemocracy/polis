//! The namer: which model names the topics, with which prompt version and
//! thinking setting, and what each model costs.

use serde::{Deserialize, Serialize};
use std::fmt;

/// The prompt version this crate builds.
pub const PROMPT_VERSION: &str = "polis-topic-names/1";

/// The models the price table knows. Any other model is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    Haiku,
    Sonnet,
}

/// Dollars per token, as the 2026-11-22 measurement priced its calls. Haiku has
/// a second rate card for prompts over [`LONG_PROMPT_TOKENS`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub input_long: f64,
    pub output_long: f64,
}

/// Above this many prompt tokens Haiku is priced at its long rate.
pub const LONG_PROMPT_TOKENS: u64 = 100_000;

impl Model {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "claude-haiku-5-5" => Some(Self::Haiku),
            "claude-sonnet-5-5" => Some(Self::Sonnet),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Haiku => "claude-haiku-5-5",
            Self::Sonnet => "claude-sonnet-5-5",
        }
    }

    pub fn price(self) -> Price {
        match self {
            Self::Haiku => Price {
                input: 0.10e-6,
                output: 0.50e-6,
                input_long: 0.50e-6,
                output_long: 2.50e-6,
            },
            Self::Sonnet => Price {
                input: 2.00e-6,
                output: 10.00e-6,
                input_long: 2.00e-6,
                output_long: 10.00e-6,
            },
        }
    }

    /// The `thinking` object sent for the `off` setting: the study's lowest
    /// setting for each model.
    pub fn thinking_off_type(self) -> &'static str {
        match self {
            Self::Haiku => "disabled",
            Self::Sonnet => "between_tools",
        }
    }

    /// Worst-case dollars of one call: every counted input token at the input
    /// price plus `max_tokens` at the output price, at the long rate when the
    /// counted input passes [`LONG_PROMPT_TOKENS`].
    pub fn worst_case_usd(self, counted_input_tokens: u64, max_tokens: u64) -> f64 {
        worst_case(self.price(), counted_input_tokens, max_tokens)
    }

    /// Dollars of an answered call from its usage, the study's formula (cache
    /// writes at 1.25 times input, cache reads at a tenth of input for Haiku
    /// and $0.10 a million for Sonnet).
    pub fn dollars(self, usage: &Usage) -> f64 {
        dollars(self.price(), self, false, usage)
    }
}

/// Where the call is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// The Claude API (`api.anthropic.com`), with an API key. The default.
    Anthropic,
    /// Claude in Amazon Bedrock: the Messages API on the `bedrock-mantle`
    /// endpoint of one region, signed with AWS Signature Version 4.
    Bedrock,
}

impl Provider {
    pub fn word(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Bedrock => "bedrock",
        }
    }

    /// The model id this provider takes in the request body.
    pub fn model_id(self, model: Model) -> &'static str {
        match (self, model) {
            (Self::Anthropic, m) => m.id(),
            (Self::Bedrock, Model::Haiku) => "anthropic.claude-haiku-5-5",
            (Self::Bedrock, Model::Sonnet) => "anthropic.claude-sonnet-5-5",
        }
    }
}

/// The highest given Bedrock price accepted, in US dollars per million tokens,
/// for input or for output. The Claude API's own rows are $2 and $10 for
/// Sonnet 5.5; a figure over this is taken to be a typing error (for example a
/// price per thousand tokens, or a missing decimal point) and makes no call.
pub const MAX_GIVEN_USD_PER_MTOK: f64 = 100.0;
/// The longest stated price source accepted, in characters. It is recorded
/// verbatim, so it is refused, not shortened, when longer.
pub const MAX_PRICE_SOURCE_CHARS: usize = 500;

/// A price per token given to the program for a Bedrock call, and where the
/// person who gave it read it. Bedrock has no built-in price: without one of
/// these, no Bedrock call is made.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GivenPrice {
    pub input_usd_per_mtok: f64,
    pub output_usd_per_mtok: f64,
    /// Where and when the figures were read, exactly as given.
    pub source: String,
}

/// Why no given price is usable: the reason `no_price` records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoPrice(pub String);

/// A Bedrock price as the settings gave it.
pub type PriceSetting = Result<GivenPrice, NoPrice>;

impl GivenPrice {
    /// Reads the three settings. Each must be present and not blank; each
    /// figure a finite number above zero and at most
    /// [`MAX_GIVEN_USD_PER_MTOK`]; the source at most
    /// [`MAX_PRICE_SOURCE_CHARS`] characters.
    pub fn from_settings(
        input: Option<&str>,
        output: Option<&str>,
        source: Option<&str>,
    ) -> PriceSetting {
        let figure = |name: &str, value: Option<&str>| -> Result<f64, NoPrice> {
            let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) else {
                return Err(NoPrice(format!("{name} is not set")));
            };
            match v.parse::<f64>() {
                Ok(x) if x.is_finite() && x > 0.0 && x <= MAX_GIVEN_USD_PER_MTOK => Ok(x),
                Ok(x) if x.is_finite() && x > MAX_GIVEN_USD_PER_MTOK => Err(NoPrice(format!(
                    "{name} is over ${MAX_GIVEN_USD_PER_MTOK} per million tokens"
                ))),
                _ => Err(NoPrice(format!(
                    "{name} is not a number of dollars above zero"
                ))),
            }
        };
        let input_usd_per_mtok = figure(crate::BEDROCK_INPUT_PRICE_ENV, input)?;
        let output_usd_per_mtok = figure(crate::BEDROCK_OUTPUT_PRICE_ENV, output)?;
        let Some(source) = source.map(str::trim).filter(|s| !s.is_empty()) else {
            return Err(NoPrice(format!(
                "{} is not set",
                crate::BEDROCK_PRICE_SOURCE_ENV
            )));
        };
        if source.chars().count() > MAX_PRICE_SOURCE_CHARS {
            return Err(NoPrice(format!(
                "{} is over {MAX_PRICE_SOURCE_CHARS} characters",
                crate::BEDROCK_PRICE_SOURCE_ENV
            )));
        }
        let price = Self {
            input_usd_per_mtok,
            output_usd_per_mtok,
            source: source.to_string(),
        };
        price.validate()?;
        Ok(price)
    }

    // Public fields may also be supplied by a library caller. Validate at the
    // call boundary as well as when parsing settings, including conversion to
    // per-token rates: a positive setting must never become a free call.
    pub(crate) fn validate(&self) -> Result<(), NoPrice> {
        for (name, rate) in [
            (crate::BEDROCK_INPUT_PRICE_ENV, self.input_usd_per_mtok),
            (crate::BEDROCK_OUTPUT_PRICE_ENV, self.output_usd_per_mtok),
        ] {
            if !rate.is_finite() || rate <= 0.0 || rate > MAX_GIVEN_USD_PER_MTOK {
                return Err(NoPrice(format!("{name} is not a usable price")));
            }
            if rate * 1e-6 == 0.0 {
                return Err(NoPrice(format!("{name} is too small to price a token")));
            }
        }
        let source = self.source.trim();
        if source.is_empty() || source.chars().count() > MAX_PRICE_SOURCE_CHARS {
            return Err(NoPrice(format!(
                "{} is not a usable source",
                crate::BEDROCK_PRICE_SOURCE_ENV
            )));
        }
        Ok(())
    }

    /// The price as a row: one rate at every prompt length.
    fn row(&self) -> Price {
        let input = self.input_usd_per_mtok * 1e-6;
        let output = self.output_usd_per_mtok * 1e-6;
        Price {
            input,
            output,
            input_long: input,
            output_long: output,
        }
    }
}

fn worst_case(p: Price, counted_input_tokens: u64, max_tokens: u64) -> f64 {
    let long = counted_input_tokens > LONG_PROMPT_TOKENS;
    let (pin, pout) = if long {
        (p.input_long, p.output_long)
    } else {
        (p.input, p.output)
    };
    counted_input_tokens as f64 * pin + max_tokens as f64 * pout
}

/// Dollars of an answered call at `p`. At the Claude API's row, cache reads
/// are a tenth of input for Haiku and $0.10 a million for Sonnet; at a given
/// price, which states no cache rate, they are counted at the input rate.
fn dollars(p: Price, model: Model, given: bool, usage: &Usage) -> f64 {
    let prompt =
        usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    let long = model == Model::Haiku && prompt > LONG_PROMPT_TOKENS;
    let (pin, pout) = if long {
        (p.input_long, p.output_long)
    } else {
        (p.input, p.output)
    };
    let read = match (given, model) {
        (true, _) => pin,
        (false, Model::Haiku) => 0.1 * pin,
        (false, Model::Sonnet) => 0.10e-6,
    };
    usage.input_tokens as f64 * pin
        + usage.cache_creation_input_tokens as f64 * 1.25 * pin
        + usage.cache_read_input_tokens as f64 * read
        + usage.output_tokens as f64 * pout
}

/// The token counts a reply reports.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

/// The thinking setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Thinking {
    /// No `thinking` field is sent: the provider's default.
    Default,
    /// Haiku `{type: disabled}`, Sonnet `{type: between_tools}`.
    Off,
}

impl Thinking {
    pub fn word(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Off => "off",
        }
    }
}

/// A checked namer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Namer {
    pub model: Model,
    pub thinking: Thinking,
    pub provider: Provider,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawNamer {
    #[serde(default)]
    by: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    model: String,
    prompt: String,
    thinking: String,
}

/// Why a `--namer` was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamerError(pub String);

impl fmt::Display for NamerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NamerError {}

impl Namer {
    /// Parses the `--namer` JSON object: `model`, `prompt`, `thinking`, and
    /// optionally `"by": "model"` and `"provider"` (`anthropic`, the default
    /// when absent, or `bedrock`).
    pub fn from_json(text: &str) -> Result<Self, NamerError> {
        let raw: RawNamer = serde_json::from_str(text)
            .map_err(|e| NamerError(format!("--namer is not a namer object: {e}")))?;
        if let Some(by) = &raw.by
            && by != "model"
        {
            return Err(NamerError(format!(
                "--namer has by {by:?}; only \"model\" names by a model"
            )));
        }
        let model = Model::from_id(&raw.model)
            .ok_or_else(|| NamerError(format!("unknown model {:?}", raw.model)))?;
        if raw.prompt != PROMPT_VERSION {
            return Err(NamerError(format!(
                "unknown prompt {:?}; this program builds {PROMPT_VERSION:?}",
                raw.prompt
            )));
        }
        let thinking = match raw.thinking.as_str() {
            "default" => Thinking::Default,
            "off" => Thinking::Off,
            other => return Err(NamerError(format!("unknown thinking {other:?}"))),
        };
        let provider = match raw.provider.as_deref() {
            None | Some("anthropic") => Provider::Anthropic,
            Some("bedrock") => Provider::Bedrock,
            Some(other) => return Err(NamerError(format!("unknown provider {other:?}"))),
        };
        Ok(Self {
            model,
            thinking,
            provider,
        })
    }

    /// The namer word of the plan's admission key, for example
    /// `claude-haiku-5-5.p1.default`; through Bedrock it is prefixed,
    /// `bedrock.claude-sonnet-5-5.p1.default`. The default provider adds no
    /// prefix, so every word written before the provider existed keeps its
    /// meaning.
    pub fn word(&self) -> String {
        let base = format!("{}.p1.{}", self.model.id(), self.thinking.word());
        match self.provider {
            Provider::Anthropic => base,
            Provider::Bedrock => format!("bedrock.{base}"),
        }
    }

    /// The model id sent in the request body.
    pub fn request_model_id(&self) -> &'static str {
        self.provider.model_id(self.model)
    }

    /// The row this call is checked and recorded at: the Claude API's own
    /// row, or, through Bedrock, only the given price (none without one).
    pub fn price_row(&self, given: Option<&GivenPrice>) -> Option<Price> {
        match self.provider {
            Provider::Anthropic => Some(self.model.price()),
            Provider::Bedrock => given.map(GivenPrice::row),
        }
    }

    /// Worst-case dollars of one call at [`Namer::price_row`]; `None` through
    /// Bedrock without a given price.
    pub fn worst_case_usd(
        &self,
        given: Option<&GivenPrice>,
        counted_input_tokens: u64,
        max_tokens: u64,
    ) -> Option<f64> {
        self.price_row(given)
            .map(|p| worst_case(p, counted_input_tokens, max_tokens))
    }

    /// Dollars of an answered call at [`Namer::price_row`].
    pub fn dollars(&self, given: Option<&GivenPrice>, usage: &Usage) -> Option<f64> {
        let given_used = self.provider == Provider::Bedrock;
        self.price_row(given)
            .map(|p| dollars(p, self.model, given_used, usage))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn worst_case_of_bowling_green_is_under_the_suggested_cap() {
        // 70,540 bytes in the saved request body, max_tokens 32,000.
        let haiku = Model::Haiku.worst_case_usd(70_540, 32_000);
        let sonnet = Model::Sonnet.worst_case_usd(70_540, 32_000);
        assert!((haiku - 0.023054).abs() < 1e-9, "{haiku}");
        assert!((sonnet - 0.46108).abs() < 1e-9, "{sonnet}");
    }

    #[test]
    fn haiku_long_rate_applies_above_the_long_prompt() {
        let w = Model::Haiku.worst_case_usd(100_001, 32_000);
        assert!((w - (100_001.0 * 0.50e-6 + 32_000.0 * 2.50e-6)).abs() < 1e-12);
    }

    #[test]
    fn dollars_match_the_study_for_a_measured_call() {
        // bg2050 b-haiku-default-r1: 25,445 in, 10,962 out.
        let u = Usage {
            input_tokens: 25_445,
            output_tokens: 10_962,
            ..Usage::default()
        };
        assert!((Model::Haiku.dollars(&u) - 0.0080255).abs() < 1e-9);
    }

    #[test]
    fn namer_parses_and_refuses() {
        let n = Namer::from_json(
            r#"{"model":"claude-haiku-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#,
        )
        .unwrap();
        assert_eq!(n.word(), "claude-haiku-5-5.p1.default");
        let n = Namer::from_json(
            r#"{"by":"model","model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"off"}"#,
        )
        .unwrap();
        assert_eq!(n.word(), "claude-sonnet-5-5.p1.off");
        for bad in [
            r#"{"model":"claude-opus-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#,
            r#"{"model":"claude-haiku-5-5","prompt":"polis-topic-names/2","thinking":"default"}"#,
            r#"{"model":"claude-haiku-5-5","prompt":"polis-topic-names/1","thinking":"high"}"#,
            r#"{"model":"claude-haiku-5-5","prompt":"polis-topic-names/1","thinking":"default","key":"x"}"#,
            r#"{"by":"keywords","model":"claude-haiku-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#,
            "claude-haiku-5-5",
        ] {
            assert!(Namer::from_json(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_provider_is_anthropic_unless_bedrock_is_named() {
        let plain = Namer::from_json(
            r#"{"model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#,
        )
        .unwrap();
        let named = Namer::from_json(
            r#"{"provider":"anthropic","model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#,
        )
        .unwrap();
        assert_eq!(plain, named);
        assert_eq!(plain.provider, Provider::Anthropic);
        assert_eq!(plain.word(), "claude-sonnet-5-5.p1.default");
        assert_eq!(plain.request_model_id(), "claude-sonnet-5-5");
        let b = Namer::from_json(
            r#"{"by":"model","provider":"bedrock","model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#,
        )
        .unwrap();
        assert_eq!(b.provider, Provider::Bedrock);
        assert_eq!(b.word(), "bedrock.claude-sonnet-5-5.p1.default");
        assert_eq!(b.request_model_id(), "anthropic.claude-sonnet-5-5");
        let h = Namer::from_json(
            r#"{"provider":"bedrock","model":"claude-haiku-5-5","prompt":"polis-topic-names/1","thinking":"off"}"#,
        )
        .unwrap();
        assert_eq!(h.request_model_id(), "anthropic.claude-haiku-5-5");
        assert_eq!(h.word(), "bedrock.claude-haiku-5-5.p1.off");
        for bad in ["vertex", "Bedrock", "", "anthropic.bedrock"] {
            let text = format!(
                r#"{{"provider":"{bad}","model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}}"#
            );
            assert!(Namer::from_json(&text).is_err(), "{bad}");
        }
    }

    fn price(input: &str, output: &str, source: &str) -> PriceSetting {
        GivenPrice::from_settings(Some(input), Some(output), Some(source))
    }

    #[test]
    fn bedrock_has_no_price_unless_one_is_given() {
        let sonnet = |provider| Namer {
            model: Model::Sonnet,
            thinking: Thinking::Default,
            provider,
        };
        let a = sonnet(Provider::Anthropic);
        let b = sonnet(Provider::Bedrock);
        assert_eq!(b.price_row(None), None);
        assert_eq!(b.worst_case_usd(None, 70_540, 32_000), None);
        // The Claude API's row ignores any given price.
        let g = price("3", "15", "read from the console").unwrap();
        assert_eq!(a.price_row(Some(&g)), Some(Model::Sonnet.price()));
        // Bowling Green's 70,540-byte body at $3 in and $15 out per million.
        let w = b.worst_case_usd(Some(&g), 70_540, 32_000).unwrap();
        assert!(
            (w - (70_540.0 * 3e-6 + 32_000.0 * 15e-6)).abs() < 1e-12,
            "{w}"
        );
        let u = Usage {
            input_tokens: 25_445,
            output_tokens: 8_217,
            cache_read_input_tokens: 1_000,
            ..Usage::default()
        };
        assert_eq!(a.dollars(Some(&g), &u), Some(Model::Sonnet.dollars(&u)));
        let d = b.dollars(Some(&g), &u).unwrap();
        assert!(
            (d - (26_445.0 * 3e-6 + 8_217.0 * 15e-6)).abs() < 1e-12,
            "{d}"
        );
        assert_eq!(b.dollars(None, &u), None);
    }

    #[test]
    fn a_given_price_must_be_present_positive_sane_and_sourced() {
        let ok = price(" 2.5 ", "12", "  AWS console, Bedrock pricing, 2026-11-26 ").unwrap();
        assert_eq!(ok.input_usd_per_mtok, 2.5);
        assert_eq!(ok.output_usd_per_mtok, 12.0);
        assert_eq!(ok.source, "AWS console, Bedrock pricing, 2026-11-26");
        assert!(price("100", "100", "s").is_ok());
        for (i, o) in [
            ("", "10"),
            ("2", " "),
            ("two", "10"),
            ("2", "0"),
            ("-2", "10"),
            ("NaN", "10"),
            ("inf", "10"),
            ("2", "100.01"),
            ("2000", "10"),
        ] {
            assert!(price(i, o, "s").is_err(), "{i:?} {o:?}");
        }
        assert!(GivenPrice::from_settings(None, Some("10"), Some("s")).is_err());
        assert!(GivenPrice::from_settings(Some("2"), None, Some("s")).is_err());
        assert!(GivenPrice::from_settings(Some("2"), Some("10"), None).is_err());
        assert!(price("2", "10", "   ").is_err());
        assert!(price("2", "10", &"x".repeat(MAX_PRICE_SOURCE_CHARS)).is_ok());
        assert!(price("2", "10", &"x".repeat(MAX_PRICE_SOURCE_CHARS + 1)).is_err());
    }
}
