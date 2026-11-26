//! The namer: which model names the topics, with which prompt version and
//! thinking setting, and what each model costs.

use serde::Deserialize;
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
        dollars(Provider::Anthropic, self, usage)
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

    /// The price row of a model through this provider.
    ///
    /// Bedrock: Amazon Bedrock prices Claude separately from the Claude API,
    /// and AWS's pricing page showed no figure for these two models when this
    /// was written. Anthropic's Bedrock page says a regional endpoint costs 10
    /// percent more than the global one, and AWS's endpoint page says
    /// `bedrock-mantle` does not route across regions, so a call to one
    /// region's `bedrock-mantle` is taken to be regional. The Bedrock rows are
    /// therefore an ESTIMATE, not a confirmed price: the Claude API's prices
    /// plus 10 percent. Replace them when the Bedrock price has been read.
    pub fn price(self, model: Model) -> Price {
        match (self, model) {
            (Self::Anthropic, m) => m.price(),
            (Self::Bedrock, Model::Haiku) => Price {
                input: 0.11e-6,
                output: 0.55e-6,
                input_long: 0.55e-6,
                output_long: 2.75e-6,
            },
            (Self::Bedrock, Model::Sonnet) => Price {
                input: 2.20e-6,
                output: 11.00e-6,
                input_long: 2.20e-6,
                output_long: 11.00e-6,
            },
        }
    }

    /// Dollars per cache-read token: a tenth of the input price for Haiku;
    /// for Sonnet $0.10 a million on the Claude API and, the same estimate as
    /// above, $0.11 through Bedrock.
    fn cache_read(self, model: Model, input_price: f64) -> f64 {
        match (self, model) {
            (_, Model::Haiku) => 0.1 * input_price,
            (Self::Anthropic, Model::Sonnet) => 0.10e-6,
            (Self::Bedrock, Model::Sonnet) => 0.11e-6,
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

fn dollars(provider: Provider, model: Model, usage: &Usage) -> f64 {
    let p = provider.price(model);
    let prompt =
        usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    let long = model == Model::Haiku && prompt > LONG_PROMPT_TOKENS;
    let (pin, pout) = if long {
        (p.input_long, p.output_long)
    } else {
        (p.input, p.output)
    };
    let read = provider.cache_read(model, pin);
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

    /// Worst-case dollars of one call at this provider's price row.
    pub fn worst_case_usd(&self, counted_input_tokens: u64, max_tokens: u64) -> f64 {
        worst_case(
            self.provider.price(self.model),
            counted_input_tokens,
            max_tokens,
        )
    }

    /// Dollars of an answered call at this provider's price row.
    pub fn dollars(&self, usage: &Usage) -> f64 {
        dollars(self.provider, self.model, usage)
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

    #[test]
    fn bedrock_rows_are_the_claude_api_rows_plus_ten_percent() {
        for m in [Model::Haiku, Model::Sonnet] {
            let a = Provider::Anthropic.price(m);
            let b = Provider::Bedrock.price(m);
            for (x, y) in [
                (a.input, b.input),
                (a.output, b.output),
                (a.input_long, b.input_long),
                (a.output_long, b.output_long),
            ] {
                assert!((y - 1.1 * x).abs() < 1e-15, "{m:?} {x} {y}");
            }
        }
        let sonnet = |provider| Namer {
            model: Model::Sonnet,
            thinking: Thinking::Default,
            provider,
        };
        // Bowling Green's 70,540-byte body: $0.4611 on the Claude API,
        // $0.5072 through Bedrock, which is over the $0.50 default cap.
        let a = sonnet(Provider::Anthropic).worst_case_usd(70_540, 32_000);
        let b = sonnet(Provider::Bedrock).worst_case_usd(70_540, 32_000);
        assert!((a - 0.46108).abs() < 1e-9, "{a}");
        assert!((b - 0.507188).abs() < 1e-9, "{b}");
        let u = Usage {
            input_tokens: 25_445,
            output_tokens: 8_217,
            cache_read_input_tokens: 1_000,
            ..Usage::default()
        };
        let da = sonnet(Provider::Anthropic).dollars(&u);
        assert!((da - Model::Sonnet.dollars(&u)).abs() < 1e-15);
        assert!((sonnet(Provider::Bedrock).dollars(&u) - 1.1 * da).abs() < 1e-12);
    }
}
