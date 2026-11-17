//! The geometry datamapplot 0.6.4 computes in Python before it writes a page:
//! the standard size of the map, the bounds of the first view, the radius of a
//! point, and where each label sits. File and line references are to
//! datamapplot 0.6.4.

pub type P = [f64; 2];

/// `compute_percentile_bounds` (`interactive_rendering.py:876-899`): the box
/// around the `percentage` percent of points nearest the mean, padded by 1% of
/// its width and height; returned as [xmin, xmax, ymin, ymax].
///
/// "Nearest" is by sqrt(dx^4 + dy^4), because the library takes the norm of the
/// squared offsets (`:883`); that is kept, since it decides which points are
/// left out.
pub fn percentile_bounds(points: &[P], percentage: f64) -> [f64; 4] {
    let n = points.len();
    let keep = ((n as f64) * (percentage / 100.0)) as usize;
    let c = mean(points);
    let mut order: Vec<(f64, usize)> = points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let (dx, dy) = (p[0] - c[0], p[1] - c[1]);
            ((dx.powi(4) + dy.powi(4)).sqrt(), i)
        })
        .collect();
    order.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let (mut x0, mut x1, mut y0, mut y1) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for &(_, i) in order.iter().take(keep) {
        x0 = x0.min(points[i][0]);
        x1 = x1.max(points[i][0]);
        y0 = y0.min(points[i][1]);
        y1 = y1.max(points[i][1]);
    }
    let (px, py) = (0.01 * (x1 - x0), 0.01 * (y1 - y0));
    [x0 - px, x1 + px, y0 - py, y1 + py]
}

pub fn mean(points: &[P]) -> P {
    let n = points.len() as f64;
    let (sx, sy) = points
        .iter()
        .fold((0.0, 0.0), |(sx, sy), p| (sx + p[0], sy + p[1]));
    [sx / n, sy / n]
}

/// The first step of `create_interactive_plot` (`create_plots.py:499-507`):
/// every map is moved so its mean is the origin and scaled so the longer side of
/// its 99.9% bounds is 30 units. The page then treats x as longitude and y as
/// latitude, so 30 units is 30 degrees.
pub fn standardize(raw: &[P]) -> Vec<P> {
    let b = percentile_bounds(raw, 99.9);
    let scale = (b[1] - b[0]).max(b[3] - b[2]);
    let c = mean(raw);
    raw.iter()
        .map(|p| {
            [
                (30.0 / scale) * (p[0] - c[0]),
                (30.0 / scale) * (p[1] - c[1]),
            ]
        })
        .collect()
}

/// The bounds the first view is fitted to (`interactive_rendering.py:1552-1555`,
/// with `initial_zoom_fraction` at its default 0.999).
pub fn view_bounds(points: &[P]) -> [f64; 4] {
    percentile_bounds(points, 0.999 * 100.0)
}

/// The radius of every point, in deck.gl "common" units: on screen it is this
/// times 2^zoom pixels (`interactive_rendering.py:1557-1566`).
pub fn point_radius(bounds: &[f64; 4], n_points: usize) -> f64 {
    let size_scale = ((bounds[1] - bounds[0]) * (bounds[3] - bounds[2])).sqrt();
    let scaling = size_scale / 25.0;
    scaling * (32.0 * 4f64.powf(-(n_points as f64).log10())).clamp(0.005, 0.1)
}

/// Where a label sits and how much it weighs: the mean of its points and the
/// fourth root of how many there are (`interactive_rendering.py:976-978`). The
/// weight sets both the label's type size and which label wins a collision.
pub fn label_anchor(points: &[P], members: &[usize]) -> (P, f64) {
    let pts: Vec<P> = members.iter().map(|&i| points[i]).collect();
    (mean(&pts), (members.len() as f64).powf(0.25))
}
