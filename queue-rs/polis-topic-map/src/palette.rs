//! The colours datamapplot 0.6.4 gives the topics of one map
//! (`palette_handling.py`): hue from the angle of a topic's label around the
//! middle of the map, so neighbours on the map are neighbours in hue; lightness
//! and chroma from how far out it sits, light and grey in the middle, dark and
//! saturated at the rim. Two entry points, as the library has:
//! `from_datamap` (its default) and `from_cmap_and_datamap` (what
//! `cvd_safer=True` selects, with the cyclic colour map CET-C2s; Delphi asks for
//! it when a map has more than 50 labels,
//! `delphi/umap_narrative/700_datamapplot_for_layer.py:747`).
//!
//! Two slips in the library's angle window are reproduced on purpose, because
//! they decide the colours a map has today (`palette_handling.py:49-57`,
//! `:204-212`): a lower edge below -pi is moved further down instead of
//! wrapped, and a window that crosses +pi selects everything outside itself.

use crate::ciecam02::Space;
use crate::layout::P;
use std::f64::consts::PI;

pub type Rgb8 = [u8; 3];

/// CET-C2s, 256 steps, from colorcet 3.1.0 (`colorcet.cm.CET_C2s`). The colour
/// maps are Peter Kovesi's (arXiv:1509.03700), licensed CC BY 4.0.
pub const CET_C2S: &str = include_str!("cet_c2s.txt");

#[allow(
    clippy::expect_used,
    reason = "the table is a constant of this crate; the tests read every row"
)]
pub fn cet_c2s() -> Vec<[f64; 3]> {
    CET_C2S
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| {
            let v: Vec<f64> = l
                .split_whitespace()
                .map(|x| x.parse().expect("CET-C2s table"))
                .collect();
            [v[0], v[1], v[2]]
        })
        .collect()
}

struct Polar {
    radii: Vec<f64>,
    thetas: Vec<f64>,
    label_radii: Vec<f64>,
    label_thetas: Vec<f64>,
}

fn polar(coords: &[P], labels: &[P]) -> Polar {
    let (mut x0, mut x1, mut y0, mut y1) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for p in coords {
        x0 = x0.min(p[0]);
        x1 = x1.max(p[0]);
        y0 = y0.min(p[1]);
        y1 = y1.max(p[1]);
    }
    let c = [x0 + (x1 - x0) / 2.0, y0 + (y1 - y0) / 2.0];
    let pol = |p: &P| {
        let (dx, dy) = (p[0] - c[0], p[1] - c[1]);
        ((dx * dx + dy * dy).sqrt(), dy.atan2(dx))
    };
    let (radii, thetas) = coords.iter().map(pol).unzip();
    let (label_radii, label_thetas) = labels.iter().map(pol).unzip();
    Polar {
        radii,
        thetas,
        label_radii,
        label_thetas,
    }
}

/// For each label, the share of the summed label radii reached at its place in
/// angular order: the library's cumulative weight, which it reads back through
/// `np.interp` at the label's own angle (`palette_handling.py:31-38`). Labels
/// at exactly the same angle (a topic that is the same set of comments at two
/// layers) all read the value of the last of them, as `np.interp` returns it.
fn angular_position(p: &Polar) -> Vec<f64> {
    let mut order: Vec<usize> = (0..p.label_thetas.len()).collect();
    order.sort_by(|&a, &b| {
        p.label_thetas[a]
            .total_cmp(&p.label_thetas[b])
            .then(a.cmp(&b))
    });
    let mut cum = Vec::with_capacity(order.len());
    let mut total = 0.0;
    for &i in &order {
        total += p.label_radii[i];
        cum.push(total);
    }
    let max = cum.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    for rank in (0..order.len().saturating_sub(1)).rev() {
        if p.label_thetas[order[rank]] == p.label_thetas[order[rank + 1]] {
            cum[rank] = cum[rank + 1];
        }
    }
    let mut out = vec![0.0; order.len()];
    for (rank, &i) in order.iter().enumerate() {
        out[i] = cum[rank] / max;
    }
    out
}

/// The radii of the points inside the angle window around `theta`, ascending.
fn window_radii(p: &Polar, theta: f64, range: f64) -> Vec<f64> {
    let mut high = theta + range;
    let mut low = theta - range;
    if high > PI {
        high -= 2.0 * PI;
    }
    if low < -PI {
        low -= 2.0 * PI;
    }
    let inside = |t: f64| {
        if low > 0.0 && high < 0.0 {
            t < low && t > high
        } else {
            t > low && t < high
        }
    };
    let mut r: Vec<f64> = p
        .thetas
        .iter()
        .zip(&p.radii)
        .filter(|(t, _)| inside(**t))
        .map(|(_, r)| *r)
        .collect();
    r.sort_by(|a, b| a.total_cmp(b));
    r
}

/// `np.interp`: linear between samples, flat beyond the ends.
fn interp(x: f64, xp: &[f64], fp: &[f64]) -> f64 {
    if x <= xp[0] {
        return fp[0];
    }
    if x >= xp[xp.len() - 1] {
        return fp[fp.len() - 1];
    }
    let j = xp.partition_point(|v| *v <= x);
    let (x0, x1) = (xp[j - 1], xp[j]);
    let slope = (fp[j] - fp[j - 1]) / (x1 - x0);
    slope * (x - x0) + fp[j - 1]
}

/// `matplotlib.colors.rgb2hex` then `to_rgb` then `int(c * 255)`, the round
/// trip `create_plots.py:603` puts every palette colour through.
pub fn to_rgb8(rgb: [f64; 3]) -> Rgb8 {
    rgb.map(|c| {
        let k = round_half_even(c.clamp(0.0, 1.0) * 255.0);
        ((k / 255.0) * 255.0) as u8
    })
}

/// The 8-bit colour `rgb2hex` writes, without the lossy read-back.
fn hex8(rgb: [f64; 3]) -> [f64; 3] {
    rgb.map(|c| round_half_even(c.clamp(0.0, 1.0) * 255.0) / 255.0)
}

fn round_half_even(x: f64) -> f64 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 && r % 2.0 != 0.0 {
        r - x.signum()
    } else {
        r
    }
}

/// `palette_from_datamap` (`palette_handling.py:7-140`), with its defaults.
/// Returns sRGB in 0..1 as the 8-bit values the library's hex strings hold.
pub fn from_datamap(space: &Space, coords: &[P], labels: &[P]) -> Vec<[f64; 3]> {
    if labels.is_empty() {
        return Vec::new();
    }
    let p = polar(coords, labels);
    let hue: Vec<f64> = angular_position(&p)
        .iter()
        .map(|w| (w * 360.0) % 360.0)
        .collect();
    let theta_range = PI / 16.0;
    let min_lightness = 10.0;
    let mut out = Vec::with_capacity(labels.len());
    // Past 255 labels the library reads lightness and chroma from 256 evenly
    // spaced angles instead of one window per label (`:81-123`).
    let uniform: Vec<f64> = (0..256)
        .map(|i| -PI + 2.0 * PI * (i as f64) / 255.0)
        .collect();
    #[allow(
        clippy::needless_range_loop,
        reason = "one index walks parallel arrays, as the Python this ports does"
    )]
    for i in 0..labels.len() {
        let (r, theta) = (p.label_radii[i], p.label_thetas[i]);
        let radii = if labels.len() < 256 {
            let mut found = Vec::new();
            for step in 0..16 {
                let range = theta_range + (PI - theta_range) * (step as f64) / 15.0;
                found = window_radii(&p, theta, range);
                if !found.is_empty() {
                    break;
                }
            }
            found
        } else {
            #[allow(clippy::unwrap_used, reason = "0..256 is never empty")]
            let nearest = (0..256)
                .min_by(|&a, &b| {
                    (uniform[a] - theta)
                        .abs()
                        .total_cmp(&(uniform[b] - theta).abs())
                })
                .unwrap();
            window_radii(&p, uniform[nearest], theta_range)
        };
        if radii.is_empty() {
            out.push(hex8(space.jch_to_srgb([45.0, 60.0, hue[i]])));
            continue;
        }
        let m = radii.len() as f64;
        let lightness: Vec<f64> = (0..radii.len())
            .map(|k| (1.0 - (k as f64) / m) * (80.0 - min_lightness) + min_lightness)
            .collect();
        let chroma: Vec<f64> = (0..radii.len())
            .map(|k| ((k as f64) / m) * 80.0 + 20.0)
            .collect();
        let j = interp(r, &radii, &lightness);
        let c = interp(r, &radii, &chroma);
        out.push(hex8(space.jch_to_srgb([j, c, hue[i]])));
    }
    out
}

fn scaling(x: f64, lo: f64, mid: f64, hi: f64) -> f64 {
    ((2.0 * (lo + hi) - 4.0 * mid) * x * x + (4.0 * mid - 3.0 * lo - hi) * x + lo).clamp(lo, hi)
}

/// `palette_from_cmap_and_datamap` (`palette_handling.py:148-256`), with its
/// defaults, for a colour map given as a table of sRGB rows.
pub fn from_cmap_and_datamap(
    space: &Space,
    cmap: &[[f64; 3]],
    coords: &[P],
    labels: &[P],
) -> Vec<[f64; 3]> {
    if labels.is_empty() {
        return Vec::new();
    }
    let n = cmap.len();
    let lookup = |table: &[[f64; 3]], v: f64| {
        let len = table.len();
        let i = ((v * len as f64) as usize).min(len - 1);
        table[i]
    };
    let ends: f64 = (0..3).map(|k| (cmap[0][k] - cmap[n - 1][k]).powi(2)).sum();
    // A colour map whose ends do not meet is walked there and back (`:162-171`).
    let cyclic: Vec<[f64; 3]> = if ends < 0.05 {
        cmap.to_vec()
    } else {
        let up = (0..128).map(|i| lookup(cmap, i as f64 / 127.0));
        let down = (0..128).map(|i| lookup(cmap, 1.0 - i as f64 / 127.0));
        up.chain(down).collect()
    };
    let p = polar(coords, labels);
    let base: Vec<[f64; 3]> = angular_position(&p)
        .iter()
        .map(|w| space.srgb_to_jch(lookup(&cyclic, *w)))
        .collect();
    let theta_range = PI / 16.0;
    let (chroma_lo, chroma_hi, light_lo, light_hi) = (20.0, 90.0, 10.0, 80.0);
    let mut out = Vec::with_capacity(labels.len());
    #[allow(
        clippy::needless_range_loop,
        reason = "one index walks parallel arrays, as the Python this ports does"
    )]
    for i in 0..labels.len() {
        let radii = window_radii(&p, p.label_thetas[i], theta_range);
        if radii.is_empty() {
            // The library raises here (np.interp on no samples). The colour map's
            // own colour is used instead, so a map is still drawn.
            out.push(hex8(space.jch_to_srgb(base[i])));
            continue;
        }
        let m = radii.len() as f64;
        let mut chroma: Vec<f64> = (0..radii.len())
            .map(|k| scaling(k as f64 / m, chroma_lo, base[i][1], chroma_hi))
            .collect();
        let mut lightness: Vec<f64> = (0..radii.len())
            .map(|k| scaling(1.0 - k as f64 / m, light_lo, base[i][0], light_hi))
            .collect();
        chroma.sort_by(|a, b| a.total_cmp(b));
        lightness.sort_by(|a, b| b.total_cmp(a));
        let j = interp(p.label_radii[i], &radii, &lightness);
        let c = interp(p.label_radii[i], &radii, &chroma);
        out.push(hex8(space.jch_to_srgb([j, c, base[i][2]])));
    }
    out
}

/// `deep_palette` (`palette_handling.py:259-272`): the darker, greyer version of
/// each topic colour that the library sets the label text in on a light ground.
pub fn deep(space: &Space, palette: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let jch: Vec<[f64; 3]> = palette.iter().map(|c| space.srgb_to_jch(*c)).collect();
    let min_j = jch.iter().map(|v| v[0]).fold(f64::INFINITY, f64::min);
    let min_c = jch.iter().map(|v| v[1]).fold(f64::INFINITY, f64::min);
    let degree = 2.0;
    jch.iter()
        .map(|v| {
            let j = (v[0] / degree).clamp((20.0 / degree).min(min_j), 50.0);
            let c = (v[1] / degree).clamp((40.0 / degree).min(min_c), 100.0);
            hex8(space.jch_to_srgb([j, c, v[2]]))
        })
        .collect()
}
