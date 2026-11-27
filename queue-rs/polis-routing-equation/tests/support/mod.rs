//! Shared helpers for the crate's tests: a small deterministic xorshift and
//! builders for one-comment inputs.
#![allow(dead_code)]

use polis_routing_equation::{
    CommentId, Counts, Extremity, ExtremityFrame, HistoricalCountFrame, HistoricalParams,
    MetaComments, Refusal, SourceId, SymmetricParams, historical_1, symmetric_1,
};

pub struct XorShift(u64);

impl XorShift {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    /// A double on the 2^-53 grid in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    /// Any f64 bit pattern: NaN payloads, infinities, subnormals, -0.0.
    pub fn any_f64(&mut self) -> f64 {
        match self.below(8) {
            0 => f64::NAN,
            1 => f64::INFINITY,
            2 => f64::NEG_INFINITY,
            3 => -0.0,
            4 => 5e-324,
            5 => 1e308,
            _ => f64::from_bits(self.next()),
        }
    }
}

pub fn src(name: &str) -> SourceId {
    SourceId::new(name).unwrap()
}

/// The weight `historical/1` gives one comment with these counts and this
/// extremity.
pub fn weight_of(
    params: &HistoricalParams,
    counts: Counts,
    extremity: f64,
    meta: bool,
) -> Result<f64, Refusal> {
    let id = CommentId::new(0);
    let frame = HistoricalCountFrame::new(src("counts"), [(id, counts)])?;
    let e = ExtremityFrame::new(src("pca"), [(id, Extremity::new(extremity)?)])?;
    let meta = if meta {
        MetaComments::new([id])?
    } else {
        MetaComments::none()
    };
    let w = historical_1(params, &frame, &e, &meta)?;
    Ok(w.get(id).unwrap().weight().get())
}

pub fn w(agreed: u32, disagreed: u32, passed: u32, extremity: f64) -> f64 {
    weight_of(
        &HistoricalParams::default(),
        Counts::new(agreed, disagreed, passed),
        extremity,
        false,
    )
    .unwrap()
}

/// The weight `symmetric/1` at its defaults gives one comment.
pub fn symmetric_weight_of(counts: Counts, extremity: f64, meta: bool) -> Result<f64, Refusal> {
    let id = CommentId::new(0);
    let frame = HistoricalCountFrame::new(src("counts"), [(id, counts)])?;
    let e = ExtremityFrame::new(src("pca"), [(id, Extremity::new(extremity)?)])?;
    let meta = if meta {
        MetaComments::new([id])?
    } else {
        MetaComments::none()
    };
    let w = symmetric_1(&SymmetricParams::default(), &frame, &e, &meta)?;
    Ok(w.get(id).unwrap().weight().get())
}
