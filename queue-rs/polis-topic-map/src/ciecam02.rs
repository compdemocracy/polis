//! CIECAM02 lightness, chroma and hue (JCh) to and from sRGB, under the viewing
//! conditions colorspacious calls `CIECAM02Space.sRGB` (white D65, Y_b = 20,
//! L_A = 64/pi/5, average surround). datamapplot 0.6.4 builds its palettes in
//! this space through colorspacious 1.1.2 (`palette_handling.py:125-139`,
//! `:259-272`); these are the same equations (Moroney et al. 2002; Fairchild,
//! Color Appearance Models, 3rd ed., ch. 16), written from the published model.
//! The tests compare against values colorspacious itself produced.

type M3 = [[f64; 3]; 3];

const M_CAT02: M3 = [
    [0.7328, 0.4296, -0.1624],
    [-0.7036, 1.6975, 0.0061],
    [0.0030, 0.0136, 0.9834],
];
const M_HPE: M3 = [
    [0.38971, 0.68898, -0.07868],
    [-0.22981, 1.18340, 0.04641],
    [0.0, 0.0, 1.0],
];
/// IEC 61966-2-1:1999, XYZ (Y = 1) to linear sRGB.
const XYZ_TO_SRGB: M3 = [
    [3.2406, -1.5372, -0.4986],
    [-0.9689, 1.8758, 0.0415],
    [0.0557, -0.2040, 1.0570],
];
const WHITE_D65: [f64; 3] = [95.047, 100.0, 108.883];
const Y_B: f64 = 20.0;
const SURROUND_F: f64 = 1.0;
const SURROUND_C: f64 = 0.69;
const SURROUND_NC: f64 = 1.0;

fn mul(m: &M3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn matmul(a: &M3, b: &M3) -> M3 {
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

fn inverse(m: &M3) -> M3 {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let c = |a: f64, b: f64, c: f64, d: f64| (a * d - b * c) / det;
    [
        [
            c(m[1][1], m[1][2], m[2][1], m[2][2]),
            c(m[0][2], m[0][1], m[2][2], m[2][1]),
            c(m[0][1], m[0][2], m[1][1], m[1][2]),
        ],
        [
            c(m[1][2], m[1][0], m[2][2], m[2][0]),
            c(m[0][0], m[0][2], m[2][0], m[2][2]),
            c(m[0][2], m[0][0], m[1][2], m[1][0]),
        ],
        [
            c(m[1][0], m[1][1], m[2][0], m[2][1]),
            c(m[0][1], m[0][0], m[2][1], m[2][0]),
            c(m[0][0], m[0][1], m[1][0], m[1][1]),
        ],
    ]
}

/// The constants of the model for the fixed viewing conditions.
pub struct Space {
    n: f64,
    z: f64,
    f_l: f64,
    n_bb: f64,
    d_rgb: [f64; 3],
    a_w: f64,
    cat02_inv: M3,
    hpe_cat02_inv: M3,
    cat02_hpe_inv: M3,
    srgb_to_xyz: M3,
}

impl Default for Space {
    fn default() -> Self {
        Self::new()
    }
}

impl Space {
    pub fn new() -> Self {
        let l_a = (64.0 / std::f64::consts::PI) / 5.0;
        let rgb_w = mul(&M_CAT02, WHITE_D65);
        let k = 1.0 / (5.0 * l_a + 1.0);
        let n = Y_B / WHITE_D65[1];
        let z = 1.48 + n.sqrt();
        let f_l = 0.2 * k.powi(4) * (5.0 * l_a)
            + 0.1 * (1.0 - k.powi(4)).powi(2) * (5.0 * l_a).powf(1.0 / 3.0);
        let n_bb = 0.725 * (1.0 / n).powf(0.2);
        let d = (SURROUND_F * (1.0 - (1.0 / 3.6) * ((-l_a - 42.0) / 92.0).exp())).clamp(0.0, 1.0);
        let d_rgb = [
            d * WHITE_D65[1] / rgb_w[0] + 1.0 - d,
            d * WHITE_D65[1] / rgb_w[1] + 1.0 - d,
            d * WHITE_D65[1] / rgb_w[2] + 1.0 - d,
        ];
        let cat02_inv = inverse(&M_CAT02);
        let hpe_cat02_inv = matmul(&M_HPE, &cat02_inv);
        let cat02_hpe_inv = matmul(&M_CAT02, &inverse(&M_HPE));
        let rgb_wc = [
            d_rgb[0] * rgb_w[0],
            d_rgb[1] * rgb_w[1],
            d_rgb[2] * rgb_w[2],
        ];
        let p_w = mul(&hpe_cat02_inv, rgb_wc);
        let adapt = |v: f64| {
            let t = (f_l * v / 100.0).powf(0.42);
            400.0 * (t / (t + 27.13)) + 0.1
        };
        let a_w = (2.0 * adapt(p_w[0]) + adapt(p_w[1]) + adapt(p_w[2]) / 20.0 - 0.305) * n_bb;
        Space {
            n,
            z,
            f_l,
            n_bb,
            d_rgb,
            a_w,
            cat02_inv,
            hpe_cat02_inv,
            cat02_hpe_inv,
            srgb_to_xyz: inverse(&XYZ_TO_SRGB),
        }
    }

    /// sRGB in 0..1 to (J, C, h in degrees).
    pub fn srgb_to_jch(&self, rgb: [f64; 3]) -> [f64; 3] {
        let lin = rgb.map(|c| {
            if c < 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        });
        let xyz = mul(&self.srgb_to_xyz, lin).map(|v| v * 100.0);
        let rgb = mul(&M_CAT02, xyz);
        let rgb_c = [
            self.d_rgb[0] * rgb[0],
            self.d_rgb[1] * rgb[1],
            self.d_rgb[2] * rgb[2],
        ];
        let p = mul(&self.hpe_cat02_inv, rgb_c);
        let pa = p.map(|v| {
            let s = if v < 0.0 {
                -1.0
            } else if v > 0.0 {
                1.0
            } else {
                0.0
            };
            let t = (self.f_l * s * v / 100.0).powf(0.42);
            s * 400.0 * (t / (t + 27.13)) + 0.1
        });
        let a = pa[0] - 12.0 * pa[1] / 11.0 + pa[2] / 11.0;
        let b = (pa[0] + pa[1] - 2.0 * pa[2]) / 9.0;
        let h_rad = b.atan2(a);
        let h = h_rad.to_degrees().rem_euclid(360.0);
        let e_t = 0.25 * ((h_rad + 2.0).cos() + 3.8);
        let big_a = self.n_bb * (2.0 * pa[0] + pa[1] + pa[2] / 20.0 - 0.305);
        let j = 100.0 * (big_a / self.a_w).powf(SURROUND_C * self.z);
        let t = (50000.0 / 13.0) * SURROUND_NC * self.n_bb * e_t * (a * a + b * b).sqrt()
            / (pa[0] + pa[1] + 1.05 * pa[2]);
        let c = t.powf(0.9) * (j / 100.0).sqrt() * (1.64 - 0.29f64.powf(self.n)).powf(0.73);
        [j, c, h]
    }

    /// (J, C, h in degrees) to sRGB, not clipped: a colour outside the sRGB
    /// gamut comes back with a channel below 0 or above 1, as colorspacious does.
    pub fn jch_to_srgb(&self, jch: [f64; 3]) -> [f64; 3] {
        let [j, c, h] = jch;
        let h_rad = h.to_radians();
        let t =
            (c / ((j / 100.0).sqrt() * (1.64 - 0.29f64.powf(self.n)).powf(0.73))).powf(1.0 / 0.9);
        let e_t = 0.25 * ((h_rad + 2.0).cos() + 3.8);
        let big_a = self.a_w * (j / 100.0).powf(1.0 / (SURROUND_C * self.z));
        let p1 = (50000.0 / 13.0) * SURROUND_NC * self.n_bb * e_t * (1.0 / t);
        let p2 = big_a / self.n_bb + 0.305;
        let p3 = 21.0 / 20.0;
        let (sin_h, cos_h) = h_rad.sin_cos();
        let num = p2 * (2.0 + p3) * (460.0 / 1403.0);
        let den2 = (2.0 + p3) * (220.0 / 1403.0);
        let den3 = (-27.0 / 1403.0) + p3 * (6300.0 / 1403.0);
        let (a, b) = if sin_h.abs() >= cos_h.abs() {
            let b = num / (p1 / sin_h + den2 * (cos_h / sin_h) + den3);
            (b * (cos_h / sin_h), b)
        } else {
            let a = num / (p1 / cos_h + den2 + den3 * (sin_h / cos_h));
            (a, a * (sin_h / cos_h))
        };
        let pa = [
            (460.0 * p2 + 451.0 * a + 288.0 * b) / 1403.0,
            (460.0 * p2 - 891.0 * a - 261.0 * b) / 1403.0,
            (460.0 * p2 - 220.0 * a - 6300.0 * b) / 1403.0,
        ];
        let p = pa.map(|v| {
            let d = v - 0.1;
            let s = if d < 0.0 {
                -1.0
            } else if d > 0.0 {
                1.0
            } else {
                0.0
            };
            s * (100.0 / self.f_l) * ((27.13 * d.abs()) / (400.0 - d.abs())).powf(1.0 / 0.42)
        });
        let rgb_c = mul(&self.cat02_hpe_inv, p);
        let rgb = [
            rgb_c[0] / self.d_rgb[0],
            rgb_c[1] / self.d_rgb[1],
            rgb_c[2] / self.d_rgb[2],
        ];
        let xyz = mul(&self.cat02_inv, rgb).map(|v| v / 100.0);
        mul(&XYZ_TO_SRGB, xyz).map(|c| {
            if c <= 0.0031308 {
                c * 12.92
            } else {
                1.055 * c.powf(1.0 / 2.4) - 0.055
            }
        })
    }
}
