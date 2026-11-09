//! The weights test: a chi-square of homogeneity per conversation between
//! Node's draws and the shadow's draws for the same requests, combined over
//! conversations into one test (the sum of the statistics against a
//! chi-square with the summed degrees of freedom), so that fifty conversations
//! tested at 0.01 each do not fail by chance a third of the time.
use std::collections::BTreeMap;

/// ln Γ(x) for x > 0 (Lanczos, g = 7, nine terms).
fn ln_gamma(x: f64) -> f64 {
    const G: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if x < 0.5 {
        let pi = std::f64::consts::PI;
        return (pi / (pi * x).sin()).ln() - ln_gamma(1.0 - x);
    }
    let x = x - 1.0;
    let mut a = G[0];
    let t = x + 7.5;
    for (i, g) in G.iter().enumerate().skip(1) {
        a += g / (x + i as f64);
    }
    0.5 * (2.0 * std::f64::consts::PI).ln() + (x + 0.5) * t.ln() - t + a.ln()
}

/// The regularized upper incomplete gamma Q(a, x).
fn gamma_q(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 1.0;
    }
    if x < a + 1.0 {
        // Series for P(a, x).
        let mut sum = 1.0 / a;
        let mut term = sum;
        let mut ap = a;
        for _ in 0..10_000 {
            ap += 1.0;
            term *= x / ap;
            sum += term;
            if term.abs() < sum.abs() * 1e-15 {
                break;
            }
        }
        let p = sum * (-x + a * x.ln() - ln_gamma(a)).exp();
        (1.0 - p).clamp(0.0, 1.0)
    } else {
        // Continued fraction for Q(a, x) (modified Lentz).
        let tiny = 1e-300;
        let mut b = x + 1.0 - a;
        let mut c = 1.0 / tiny;
        let mut d = 1.0 / b;
        let mut h = d;
        for i in 1..10_000 {
            let an = -(i as f64) * (i as f64 - a);
            b += 2.0;
            d = an * d + b;
            if d.abs() < tiny {
                d = tiny;
            }
            c = b + an / c;
            if c.abs() < tiny {
                c = tiny;
            }
            d = 1.0 / d;
            let delta = d * c;
            h *= delta;
            if (delta - 1.0).abs() < 1e-15 {
                break;
            }
        }
        ((-x + a * x.ln() - ln_gamma(a)).exp() * h).clamp(0.0, 1.0)
    }
}

/// P(X ≥ x) for X chi-square with `df` degrees of freedom.
pub fn chi_square_sf(x: f64, df: f64) -> f64 {
    if df <= 0.0 {
        return 1.0;
    }
    gamma_q(df / 2.0, x / 2.0)
}

/// Draw counts per statement, Node's and the shadow's, in one conversation.
pub type Cells = BTreeMap<String, (u64, u64)>;

/// Statements drawn fewer than this many times in all (both sides) are pooled
/// into one cell, so that every cell's expected count is about five or more.
const POOL_BELOW: u64 = 10;

/// One conversation's 2 × k homogeneity test: (statistic, degrees of freedom).
/// None when there is nothing to compare (fewer than two cells after pooling).
pub fn homogeneity(cells: &Cells) -> Option<(f64, f64)> {
    let mut kept: Vec<(u64, u64)> = vec![];
    let mut pooled = (0u64, 0u64);
    for &(a, b) in cells.values() {
        if a + b < POOL_BELOW {
            pooled.0 += a;
            pooled.1 += b;
        } else {
            kept.push((a, b));
        }
    }
    if pooled.0 + pooled.1 > 0 {
        if pooled.0 + pooled.1 < POOL_BELOW && !kept.is_empty() {
            // Still too small: fold it into the smallest kept cell.
            let smallest = kept
                .iter()
                .enumerate()
                .min_by_key(|(_, (a, b))| a + b)
                .map(|(i, _)| i)?;
            kept[smallest].0 += pooled.0;
            kept[smallest].1 += pooled.1;
        } else {
            kept.push(pooled);
        }
    }
    if kept.len() < 2 {
        return None;
    }
    let rows = (
        kept.iter().map(|c| c.0).sum::<u64>() as f64,
        kept.iter().map(|c| c.1).sum::<u64>() as f64,
    );
    if rows.0 == 0.0 || rows.1 == 0.0 {
        return None;
    }
    let total = rows.0 + rows.1;
    let mut statistic = 0.0;
    for &(a, b) in &kept {
        let column = (a + b) as f64;
        for (observed, row) in [(a as f64, rows.0), (b as f64, rows.1)] {
            let expected = row * column / total;
            statistic += (observed - expected).powi(2) / expected;
        }
    }
    Some((statistic, (kept.len() - 1) as f64))
}

/// The combined test over conversations with at least `min_draws` paired
/// draws.
#[derive(Debug, Clone, PartialEq)]
pub struct Combined {
    pub conversations: usize,
    pub draws: u64,
    pub statistic: f64,
    pub df: f64,
    pub p: f64,
}

pub fn combined<'a>(conversations: impl Iterator<Item = &'a Cells>, min_draws: u64) -> Combined {
    let mut out = Combined {
        conversations: 0,
        draws: 0,
        statistic: 0.0,
        df: 0.0,
        p: 1.0,
    };
    for cells in conversations {
        let draws: u64 = cells.values().map(|c| c.0).sum();
        if draws < min_draws {
            continue;
        }
        if let Some((statistic, df)) = homogeneity(cells) {
            out.conversations += 1;
            out.draws += draws;
            out.statistic += statistic;
            out.df += df;
        }
    }
    out.p = chi_square_sf(out.statistic, out.df);
    out
}
