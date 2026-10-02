//! consistency.score / consistency.pick_reference: model-free cross-shot consistency scoring.
//!
//! ffmpeg decodes each frame into a small raw RGB buffer (centre square crop, area-scaled); everything
//! after that is pure Rust over those buffers, so it can be unit-tested with synthetic frames:
//!
//! - structure: 8x8 DCT perceptual hash over a 32x32 luma image, hamming similarity;
//! - colour distribution: RGB (3 x 8 bins) and HSV (16 hue + 4 sat + 4 val bins) histogram intersection;
//! - main colours: top-5 dominant quantised colours (4 levels per channel), symmetric nearest-colour distance.
//!
//! Combined score (0-100) = 100 * (0.5 * phash + 0.3 * histogram + 0.2 * palette). This measures colour and
//! composition only; it cannot tell whether two faces belong to the same person.

use crate::ffmpeg::{self, FfError};
use serde_json::{json, Value};
use std::path::Path;

/// Side of the RGB frame used for histogram / palette (and, downsampled, the hash).
pub const SCORE_SIZE: usize = 64;
/// Side of the luma image the DCT hash is computed on.
pub const HASH_SIZE: usize = 32;
/// Side of the frame used for the sharpness measure in pick_reference.
pub const SHARP_SIZE: usize = 256;
pub const DEFAULT_SAMPLE_FRAMES: u64 = 5;
pub const MAX_SAMPLE_FRAMES: u64 = 30;
pub const DEFAULT_MIN_SCORE: f64 = 60.0;
/// `retry` when the score is more than this below `min_score`; in between it is `check`.
pub const RETRY_MARGIN: f64 = 20.0;
pub const W_PHASH: f64 = 0.5;
pub const W_HIST: f64 = 0.3;
pub const W_PALETTE: f64 = 0.2;
/// Hamming distance (of 64 bits) at which the hash part reaches 0. Unrelated images sit around 32.
pub const PHASH_ZERO_DISTANCE: f64 = 24.0;
/// Normalised RGB distance (1 = opposite cube corners) at which the palette part reaches 0.
pub const PALETTE_ZERO_DISTANCE: f64 = 0.25;
pub const PALETTE_COLOURS: usize = 5;
/// pick_reference: resolution part saturates at this many pixels per side (sqrt(w*h)).
pub const FULL_RES_SIDE: f64 = 1024.0;

// ---------------------------------------------------------------------------------------------
// Frame buffers
// ---------------------------------------------------------------------------------------------

/// Packed 8-bit RGB frame, row-major.
#[derive(Clone, Debug)]
pub struct Rgb {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

impl Rgb {
    pub fn new(w: usize, h: usize, data: Vec<u8>) -> Result<Rgb, String> {
        if w == 0 || h == 0 || data.len() != w * h * 3 {
            return Err(format!("expected {} bytes for {w}x{h} rgb24, got {}", w * h * 3, data.len()));
        }
        Ok(Rgb { w, h, data })
    }

    /// Rec.601 luma, one byte per pixel.
    pub fn luma(&self) -> Vec<u8> {
        self.data
            .chunks_exact(3)
            .map(|p| (0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64).round().clamp(0.0, 255.0) as u8)
            .collect()
    }

    /// Box-filter downsample by an integer factor (dimensions must divide).
    pub fn downsample(&self, factor: usize) -> Rgb {
        assert!(factor >= 1 && self.w % factor == 0 && self.h % factor == 0, "bad downsample factor");
        let (w, h) = (self.w / factor, self.h / factor);
        let mut out = vec![0u8; w * h * 3];
        let n = (factor * factor) as u32;
        for y in 0..h {
            for x in 0..w {
                let mut acc = [0u32; 3];
                for dy in 0..factor {
                    for dx in 0..factor {
                        let i = ((y * factor + dy) * self.w + (x * factor + dx)) * 3;
                        for c in 0..3 {
                            acc[c] += self.data[i + c] as u32;
                        }
                    }
                }
                let o = (y * w + x) * 3;
                for c in 0..3 {
                    out[o + c] = ((acc[c] + n / 2) / n) as u8;
                }
            }
        }
        Rgb { w, h, data: out }
    }
}

/// Box-filter downsample of a gray image by an integer factor.
pub fn downsample_gray(g: &[u8], w: usize, h: usize, factor: usize) -> Vec<u8> {
    assert!(factor >= 1 && w % factor == 0 && h % factor == 0 && g.len() == w * h, "bad downsample");
    let (ow, oh) = (w / factor, h / factor);
    let n = (factor * factor) as u32;
    let mut out = vec![0u8; ow * oh];
    for y in 0..oh {
        for x in 0..ow {
            let mut acc = 0u32;
            for dy in 0..factor {
                for dx in 0..factor {
                    acc += g[(y * factor + dy) * w + (x * factor + dx)] as u32;
                }
            }
            out[y * ow + x] = ((acc + n / 2) / n) as u8;
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Perceptual hash (DCT)
// ---------------------------------------------------------------------------------------------

/// 64-bit DCT hash of an `n x n` gray image (n >= 8): 2-D DCT-II, top-left 8x8 block, each bit = coefficient
/// above the median of the 63 non-DC coefficients.
pub fn phash(gray: &[u8], n: usize) -> u64 {
    assert!(n >= 8 && gray.len() == n * n, "phash expects an n x n gray image with n >= 8");
    let nf = n as f64;
    // cos table: c[u][x] = cos((2x+1) u pi / 2n), only u < 8 is needed
    let cos: Vec<Vec<f64>> = (0..8)
        .map(|u| (0..n).map(|x| (((2 * x + 1) as f64) * (u as f64) * std::f64::consts::PI / (2.0 * nf)).cos()).collect())
        .collect();
    let alpha = |u: usize| if u == 0 { (1.0 / nf).sqrt() } else { (2.0 / nf).sqrt() };
    // separable: rows first (over x), then columns (over y)
    let mut rows = vec![0f64; n * 8]; // rows[y*8+u]
    for y in 0..n {
        for u in 0..8 {
            let mut s = 0.0;
            for x in 0..n {
                s += gray[y * n + x] as f64 * cos[u][x];
            }
            rows[y * 8 + u] = alpha(u) * s;
        }
    }
    let mut coef = [0f64; 64]; // coef[v*8+u]
    for v in 0..8 {
        for u in 0..8 {
            let mut s = 0.0;
            for y in 0..n {
                s += rows[y * 8 + u] * cos[v][y];
            }
            coef[v * 8 + u] = alpha(v) * s;
        }
    }
    let mut ac: Vec<f64> = coef[1..].to_vec();
    ac.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = (ac[31] + ac[32]) / 2.0;
    let mut bits = 0u64;
    for (i, c) in coef.iter().enumerate() {
        if *c > median {
            bits |= 1u64 << i;
        }
    }
    bits
}

pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Hash part in 0..=1: 1 at distance 0, 0 at `PHASH_ZERO_DISTANCE` and beyond.
pub fn phash_similarity(a: u64, b: u64) -> f64 {
    (1.0 - hamming(a, b) as f64 / PHASH_ZERO_DISTANCE).clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------------------------

/// Normalised colour histograms: `rgb` = 3 channels x 8 bins (each channel sums to 1),
/// `hsv` = 16 hue bins + 4 saturation bins + 4 value bins (each group sums to 1).
#[derive(Clone, Debug, PartialEq)]
pub struct Hist {
    pub rgb: [f32; 24],
    pub hsv: [f32; 24],
}

/// (h in [0,360), s in [0,1], v in [0,1])
pub fn rgb_to_hsv(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let (r, g, b) = (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let v = max;
    let s = if max > 0.0 { d / max } else { 0.0 };
    let h = if d <= 0.0 {
        0.0
    } else if max == r {
        60.0 * (((g - b) / d).rem_euclid(6.0))
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (h.rem_euclid(360.0), s, v)
}

pub fn histograms(f: &Rgb) -> Hist {
    let mut rgb = [0f32; 24];
    let mut hsv = [0f32; 24];
    for p in f.data.chunks_exact(3) {
        for c in 0..3 {
            rgb[c * 8 + (p[c] >> 5) as usize] += 1.0;
        }
        let (h, s, v) = rgb_to_hsv(p[0], p[1], p[2]);
        let hb = ((h / 360.0 * 16.0) as usize).min(15);
        let sb = ((s * 4.0) as usize).min(3);
        let vb = ((v * 4.0) as usize).min(3);
        hsv[hb] += 1.0;
        hsv[16 + sb] += 1.0;
        hsv[20 + vb] += 1.0;
    }
    let n = (f.w * f.h) as f32;
    for x in rgb.iter_mut().chain(hsv.iter_mut()) {
        *x /= n;
    }
    Hist { rgb, hsv }
}

fn intersect(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x.min(*y) as f64).sum()
}

/// Histogram part in 0..=1: mean intersection of the three RGB channels, averaged with the mean
/// intersection of hue / saturation / value.
pub fn hist_similarity(a: &Hist, b: &Hist) -> f64 {
    let rgb = (0..3).map(|c| intersect(&a.rgb[c * 8..c * 8 + 8], &b.rgb[c * 8..c * 8 + 8])).sum::<f64>() / 3.0;
    let hsv = (intersect(&a.hsv[0..16], &b.hsv[0..16]) + intersect(&a.hsv[16..20], &b.hsv[16..20]) + intersect(&a.hsv[20..24], &b.hsv[20..24])) / 3.0;
    ((rgb + hsv) / 2.0).clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------------------------
// Dominant palette
// ---------------------------------------------------------------------------------------------

/// Dominant colours: (centre colour in 0..255 per channel, weight); weights sum to 1.
#[derive(Clone, Debug, PartialEq)]
pub struct Palette(pub Vec<([f64; 3], f64)>);

pub fn palette(f: &Rgb, k: usize) -> Palette {
    let mut bins = [0u32; 64];
    for p in f.data.chunks_exact(3) {
        let i = ((p[0] >> 6) as usize) * 16 + ((p[1] >> 6) as usize) * 4 + (p[2] >> 6) as usize;
        bins[i] += 1;
    }
    let mut order: Vec<usize> = (0..64).filter(|i| bins[*i] > 0).collect();
    order.sort_by(|a, b| bins[*b].cmp(&bins[*a]).then(a.cmp(b)));
    order.truncate(k.max(1));
    let total: f64 = order.iter().map(|i| bins[*i] as f64).sum();
    let centre = |i: usize| {
        let lvl = |x: usize| (x * 64 + 32) as f64;
        [lvl(i / 16), lvl((i / 4) % 4), lvl(i % 4)]
    };
    Palette(order.into_iter().map(|i| (centre(i), bins[i] as f64 / total)).collect())
}

fn directed_palette_distance(a: &Palette, b: &Palette) -> f64 {
    const MAX: f64 = 441.672_955_930_063_7; // 255 * sqrt(3)
    let mut sum = 0.0;
    for (ca, wa) in &a.0 {
        let nearest = b
            .0
            .iter()
            .map(|(cb, _)| ((ca[0] - cb[0]).powi(2) + (ca[1] - cb[1]).powi(2) + (ca[2] - cb[2]).powi(2)).sqrt() / MAX)
            .fold(f64::INFINITY, f64::min);
        sum += wa * if nearest.is_finite() { nearest } else { 1.0 };
    }
    sum
}

/// Palette part in 0..=1: 1 when every dominant colour has an identical counterpart,
/// 0 once the weighted nearest-colour distance reaches `PALETTE_ZERO_DISTANCE`.
pub fn palette_similarity(a: &Palette, b: &Palette) -> f64 {
    if a.0.is_empty() || b.0.is_empty() {
        return 0.0;
    }
    let d = (directed_palette_distance(a, b) + directed_palette_distance(b, a)) / 2.0;
    (1.0 - d / PALETTE_ZERO_DISTANCE).clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------------------------
// Features, comparison, suggestion
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Features {
    pub phash: u64,
    pub hist: Hist,
    pub palette: Palette,
}

/// Features of a square frame whose side is a multiple of `HASH_SIZE` (e.g. the 64x64 score frame).
pub fn features(f: &Rgb) -> Features {
    assert!(f.w == f.h && f.w % HASH_SIZE == 0, "features expects a square frame, side a multiple of {HASH_SIZE}");
    let gray = f.luma();
    let small = if f.w == HASH_SIZE { gray } else { downsample_gray(&gray, f.w, f.h, f.w / HASH_SIZE) };
    Features { phash: phash(&small, HASH_SIZE), hist: histograms(f), palette: palette(f, PALETTE_COLOURS) }
}

/// Per-part similarities and the combined score, all on a 0-100 scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Parts {
    pub phash: f64,
    pub histogram: f64,
    pub palette: f64,
    pub score: f64,
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

pub fn compare(a: &Features, b: &Features) -> Parts {
    let p = phash_similarity(a.phash, b.phash);
    let h = hist_similarity(&a.hist, &b.hist);
    let c = palette_similarity(&a.palette, &b.palette);
    Parts { phash: r1(p * 100.0), histogram: r1(h * 100.0), palette: r1(c * 100.0), score: r1((W_PHASH * p + W_HIST * h + W_PALETTE * c) * 100.0) }
}

impl Parts {
    pub fn mean(list: &[Parts]) -> Parts {
        if list.is_empty() {
            return Parts { phash: 0.0, histogram: 0.0, palette: 0.0, score: 0.0 };
        }
        let n = list.len() as f64;
        let avg = |f: fn(&Parts) -> f64| r1(list.iter().map(f).sum::<f64>() / n);
        Parts { phash: avg(|p| p.phash), histogram: avg(|p| p.histogram), palette: avg(|p| p.palette), score: avg(|p| p.score) }
    }
    pub fn to_json(&self) -> Value {
        json!({ "phash": self.phash, "histogram": self.histogram, "palette": self.palette })
    }
}

/// `ok` at or above `min_score`, `retry` more than `RETRY_MARGIN` below it, `check` in between.
pub fn suggestion(score: f64, min_score: f64) -> &'static str {
    if score >= min_score {
        "ok"
    } else if score < min_score - RETRY_MARGIN {
        "retry"
    } else {
        "check"
    }
}

/// Evenly spaced sample times (seconds) strictly inside [0, duration): (i + 0.5) * duration / n.
pub fn sample_times(duration: f64, n: u64) -> Vec<f64> {
    let n = n.max(1);
    (0..n).map(|i| (i as f64 + 0.5) * duration / n as f64).collect()
}

/// Still image (one frame to grab) vs. video (sample several frames), from a `media.probe` result.
pub fn is_still_image(probe: &Value) -> bool {
    if probe["hasVideo"] != true {
        return true;
    }
    let fmt = probe["formatName"].as_str().unwrap_or("");
    if fmt.split(',').any(|f| f == "image2" || f.ends_with("_pipe")) {
        return true;
    }
    const STILL: &[&str] = &["png", "mjpeg", "jpeg", "jpegls", "webp", "bmp", "tiff", "ppm", "pgm", "psd"];
    if STILL.contains(&probe["video"]["codec"].as_str().unwrap_or("")) {
        return true;
    }
    match probe["durationSec"].as_f64() {
        Some(d) => d < 0.2,
        None => true,
    }
}

// ---------------------------------------------------------------------------------------------
// Sharpness and candidate ranking (pick_reference)
// ---------------------------------------------------------------------------------------------

/// Variance of the 4-neighbour Laplacian over the interior of a gray image; higher = sharper.
pub fn laplacian_variance(g: &[u8], w: usize, h: usize) -> f64 {
    assert!(g.len() == w * h, "bad gray size");
    if w < 3 || h < 3 {
        return 0.0;
    }
    let mut vals = Vec::with_capacity((w - 2) * (h - 2));
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let c = g[y * w + x] as f64;
            let l = 4.0 * c - g[y * w + x - 1] as f64 - g[y * w + x + 1] as f64 - g[(y - 1) * w + x] as f64 - g[(y + 1) * w + x] as f64;
            vals.push(l);
        }
    }
    let n = vals.len() as f64;
    let mean = vals.iter().sum::<f64>() / n;
    vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub path: String,
    pub width: i64,
    pub height: i64,
    pub sharpness: f64,
    /// 0-100 consistency score against the anchor, when one was given.
    pub similarity: Option<f64>,
}

/// Rank candidates: sharpness relative to the sharpest candidate, resolution (saturating at
/// `FULL_RES_SIDE` per side) and, with an anchor, similarity to it.
/// Weights: with anchor 0.4 sharpness / 0.2 resolution / 0.4 similarity; without 0.65 / 0.35.
pub fn rank(cands: &[Candidate]) -> Vec<Value> {
    let max_sharp = cands.iter().map(|c| c.sharpness).fold(0.0, f64::max);
    let mut rows: Vec<(f64, Value)> = cands
        .iter()
        .map(|c| {
            let sharp = if max_sharp > 0.0 { c.sharpness / max_sharp } else { 0.0 };
            let res = (((c.width.max(0) * c.height.max(0)) as f64).sqrt() / FULL_RES_SIDE).min(1.0);
            let score = match c.similarity {
                Some(sim) => 0.4 * sharp + 0.2 * res + 0.4 * (sim / 100.0),
                None => 0.65 * sharp + 0.35 * res,
            };
            let score = r1(score * 100.0);
            (
                score,
                json!({
                    "path": c.path, "score": score, "sharpness": r1(c.sharpness), "width": c.width, "height": c.height,
                    "similarity": c.similarity.map(r1),
                }),
            )
        })
        .collect();
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    rows.into_iter().map(|(_, v)| v).collect()
}

// ---------------------------------------------------------------------------------------------
// ffmpeg glue
// ---------------------------------------------------------------------------------------------

fn bad(msg: &str) -> FfError {
    FfError { code: crate::rpc::ERR_INVALID_PARAMS, message: msg.into(), data: None }
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, FfError> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad(&format!("params.{key} must be a non-empty string")))
}

fn timeout_param(params: &Value) -> u64 {
    params.get("timeoutSec").and_then(|v| v.as_u64()).unwrap_or(30).clamp(1, 600)
}

/// Decode one frame (at `at` seconds for videos) as a `size x size` rgb24 buffer: centre-square crop, area scaling.
pub async fn grab_frame(exe: &Path, path: &str, at: Option<f64>, size: usize, timeout: u64) -> Result<Rgb, FfError> {
    let mut args: Vec<String> = ["-hide_banner", "-v", "error", "-nostdin"].iter().map(|s| s.to_string()).collect();
    if let Some(t) = at {
        args.push("-ss".into());
        args.push(format!("{t:.3}"));
    }
    args.extend(["-i", path, "-an", "-sn", "-frames:v", "1", "-vf"].iter().map(|s| s.to_string()));
    args.push(format!("crop=min(iw\\,ih):min(iw\\,ih),scale={size}:{size}:flags=area"));
    args.extend(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"].iter().map(|s| s.to_string()));
    let out = ffmpeg::run_raw(exe, "ffmpeg", &args, timeout).await?;
    if !out.status_ok {
        let why = ffmpeg::tail(&out.stderr, 300);
        let msg = if Path::new(path).exists() { format!("ffmpeg could not decode {path}: {why}") } else { format!("media file not found: {path}") };
        return Err(FfError::failed(msg, &out.stderr, out.code));
    }
    Rgb::new(size, size, out.stdout).map_err(|e| FfError::output(format!("ffmpeg frame output for {path}: {e}")))
}

async fn probe_for(path: &str, params: &Value) -> Result<Value, FfError> {
    let mut p = json!({ "path": path, "timeoutSec": timeout_param(params) });
    if let Some(d) = params.get("ffmpegDir") {
        p["ffmpegDir"] = d.clone();
    }
    crate::media::probe(&p).await
}

/// `consistency.score` {reference, target, sample_frames?, min_score?, timeoutSec?, ffmpegDir?}
pub async fn score(params: &Value) -> Result<Value, FfError> {
    let reference = str_param(params, "reference")?;
    let target = str_param(params, "target")?;
    let n = params.get("sample_frames").and_then(|v| v.as_u64()).unwrap_or(DEFAULT_SAMPLE_FRAMES).clamp(1, MAX_SAMPLE_FRAMES);
    let min_score = params.get("min_score").and_then(|v| v.as_f64()).unwrap_or(DEFAULT_MIN_SCORE).clamp(0.0, 100.0);
    let ffdir = params.get("ffmpegDir").and_then(|v| v.as_str());
    let exe = ffmpeg::locate("ffmpeg", ffdir)?;
    let timeout = timeout_param(params);

    let ref_feat = features(&grab_frame(&exe, reference, None, SCORE_SIZE, timeout).await?);
    let probe = probe_for(target, params).await?;
    let still = is_still_image(&probe);
    let times: Vec<Option<f64>> = if still {
        vec![None]
    } else {
        sample_times(probe["durationSec"].as_f64().unwrap_or(0.0), n).into_iter().map(Some).collect()
    };
    let mut frames = Vec::with_capacity(times.len());
    let mut parts = Vec::with_capacity(times.len());
    for t in times {
        let p = compare(&ref_feat, &features(&grab_frame(&exe, target, t, SCORE_SIZE, timeout).await?));
        frames.push(json!({ "t_ms": (t.unwrap_or(0.0) * 1000.0).round() as i64, "score": p.score, "parts": p.to_json() }));
        parts.push(p);
    }
    let mean = Parts::mean(&parts);
    Ok(json!({
        "reference": reference, "target": target, "kind": if still { "image" } else { "video" },
        "score": mean.score, "parts": mean.to_json(), "frames": frames,
        "suggestion": suggestion(mean.score, min_score), "min_score": min_score,
        "weights": { "phash": W_PHASH, "histogram": W_HIST, "palette": W_PALETTE },
    }))
}

/// `consistency.pick_reference` {candidates: [path], anchor?, timeoutSec?, ffmpegDir?}
pub async fn pick_reference(params: &Value) -> Result<Value, FfError> {
    let cands: Vec<String> = match params.get("candidates").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() && a.iter().all(|x| x.as_str().map(|s| !s.is_empty()).unwrap_or(false)) => {
            a.iter().filter_map(|x| x.as_str().map(String::from)).collect()
        }
        _ => return Err(bad("params.candidates must be a non-empty array of paths")),
    };
    let anchor = params.get("anchor").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let ffdir = params.get("ffmpegDir").and_then(|v| v.as_str());
    let exe = ffmpeg::locate("ffmpeg", ffdir)?;
    let timeout = timeout_param(params);

    // Same decode path as the candidates (SHARP_SIZE, then box-downsampled), so an identical file scores exactly 100.
    let anchor_feat = match anchor {
        Some(a) => Some(features(&grab_frame(&exe, a, None, SHARP_SIZE, timeout).await?.downsample(SHARP_SIZE / SCORE_SIZE))),
        None => None,
    };
    let mut ok = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in cands {
        if Some(path.as_str()) == anchor || !seen.insert(path.clone()) {
            continue;
        }
        let item = async {
            let probe = probe_for(&path, params).await?;
            let (width, height) = (probe["video"]["width"].as_i64().unwrap_or(0), probe["video"]["height"].as_i64().unwrap_or(0));
            if probe["hasVideo"] != true || width <= 0 || height <= 0 {
                return Err(FfError::output(format!("no decodable picture in {path}")));
            }
            let big = grab_frame(&exe, &path, None, SHARP_SIZE, timeout).await?;
            let sharpness = laplacian_variance(&big.luma(), big.w, big.h);
            let similarity = anchor_feat.as_ref().map(|a| compare(a, &features(&big.downsample(SHARP_SIZE / SCORE_SIZE))).score);
            Ok::<Candidate, FfError>(Candidate { path: path.clone(), width, height, sharpness, similarity })
        }
        .await;
        match item {
            Ok(c) => ok.push(c),
            // A missing toolchain is fatal; a single unreadable candidate is reported and skipped.
            Err(e) if e.code == ffmpeg::ERR_FFMPEG_MISSING => return Err(e),
            Err(e) => skipped.push(json!({ "path": path, "error": e.message })),
        }
    }
    Ok(json!({ "anchor": anchor, "ranked": rank(&ok), "skipped": skipped }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gradient background, bright square and dark disc: has structure, colour spread and dominant colours.
    fn base(n: usize) -> Rgb {
        let mut d = vec![0u8; n * n * 3];
        for y in 0..n {
            for x in 0..n {
                let i = (y * n + x) * 3;
                let (fx, fy) = (x as f64 / n as f64, y as f64 / n as f64);
                let mut px = [(40.0 + 160.0 * fx) as u8, (60.0 + 120.0 * fy) as u8, 150u8];
                if (0.15..0.4).contains(&fx) && (0.2..0.5).contains(&fy) {
                    px = [240, 235, 220];
                }
                let (cx, cy) = (fx - 0.7, fy - 0.65);
                if cx * cx + cy * cy < 0.03 {
                    px = [25, 20, 30];
                }
                d[i..i + 3].copy_from_slice(&px);
            }
        }
        Rgb::new(n, n, d).unwrap()
    }

    fn rotate_channels(f: &Rgb) -> Rgb {
        let data = f.data.chunks_exact(3).flat_map(|p| [p[1], p[2], p[0]]).collect();
        Rgb::new(f.w, f.h, data).unwrap()
    }

    fn noise(n: usize, seed: u64) -> Rgb {
        let mut s = seed;
        let mut next = move || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (s >> 33) as u8
        };
        let data = (0..n * n * 3).map(|_| next()).collect();
        Rgb::new(n, n, data).unwrap()
    }

    fn blend(a: &Rgb, b: &Rgb, t: f64) -> Rgb {
        let data = a.data.iter().zip(&b.data).map(|(x, y)| ((*x as f64) * (1.0 - t) + (*y as f64) * t).round() as u8).collect();
        Rgb::new(a.w, a.h, data).unwrap()
    }

    fn score_of(a: &Rgb, b: &Rgb) -> Parts {
        compare(&features(a), &features(b))
    }

    #[test]
    fn identical_frames_score_100() {
        let f = base(64);
        let p = score_of(&f, &f);
        assert_eq!(p.score, 100.0);
        assert_eq!((p.phash, p.histogram, p.palette), (100.0, 100.0, 100.0));
        assert_eq!(hamming(features(&f).phash, features(&f).phash), 0);
    }

    #[test]
    fn same_image_colour_shifted_and_noise_are_monotonic() {
        let f = base(64);
        let same = score_of(&f, &f).score;
        let shifted = score_of(&f, &rotate_channels(&f));
        let random = score_of(&f, &noise(64, 7));
        assert!(shifted.score < same, "shifted {shifted:?}");
        assert!(shifted.score > random.score + 10.0, "shifted {shifted:?} vs noise {random:?}");
        assert!(random.score < 35.0, "noise {random:?}");
        // a hue shift keeps the structure but changes the colours
        assert!(shifted.phash >= 60.0, "structure survives a colour shift: {shifted:?}");
        assert!(shifted.histogram < 90.0 && shifted.palette < 90.0, "colour parts drop: {shifted:?}");
    }

    #[test]
    fn progressively_more_noise_never_raises_the_score() {
        let f = base(64);
        let nz = noise(64, 11);
        let steps: Vec<f64> = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0].iter().map(|t| score_of(&f, &blend(&f, &nz, *t)).score).collect();
        for w in steps.windows(2) {
            assert!(w[1] <= w[0] + 0.5, "non-increasing within rounding: {steps:?}");
        }
        assert!(steps[0] > steps[2] && steps[2] > steps[5], "{steps:?}");
    }

    #[test]
    fn hash_is_robust_to_resampling_and_mild_brightness() {
        let f = base(64);
        let h64 = features(&f).phash;
        // 2x box-downsampled copy, then the hash computed straight on 32x32
        let g32 = downsample_gray(&f.luma(), 64, 64, 2);
        assert!(hamming(h64, phash(&g32, HASH_SIZE)) <= 2);
        let brighter = Rgb::new(64, 64, f.data.iter().map(|v| v.saturating_add(20)).collect()).unwrap();
        assert!(hamming(h64, features(&brighter).phash) <= 4);
    }

    #[test]
    fn histogram_and_palette_basics() {
        let f = base(64);
        let h = histograms(&f);
        for c in 0..3 {
            assert!((h.rgb[c * 8..c * 8 + 8].iter().sum::<f32>() - 1.0).abs() < 1e-4);
        }
        assert!((h.hsv[0..16].iter().sum::<f32>() - 1.0).abs() < 1e-4);
        assert_eq!(hist_similarity(&h, &h), 1.0);
        let p = palette(&f, PALETTE_COLOURS);
        assert!(p.0.len() <= PALETTE_COLOURS && (p.0.iter().map(|x| x.1).sum::<f64>() - 1.0).abs() < 1e-9);
        assert_eq!(palette_similarity(&p, &p), 1.0);
        let far = palette(&Rgb::new(2, 2, vec![255; 12]).unwrap(), 5);
        let dark = palette(&Rgb::new(2, 2, vec![0; 12]).unwrap(), 5);
        assert_eq!(palette_similarity(&far, &dark), 0.0);
        assert_eq!(rgb_to_hsv(255, 0, 0).0, 0.0);
        assert!((rgb_to_hsv(0, 255, 0).0 - 120.0).abs() < 1e-9);
        assert!((rgb_to_hsv(0, 0, 255).0 - 240.0).abs() < 1e-9);
        assert_eq!(rgb_to_hsv(128, 128, 128).1, 0.0);
    }

    #[test]
    fn suggestion_thresholds_and_sample_times() {
        assert_eq!(suggestion(60.0, 60.0), "ok");
        assert_eq!(suggestion(59.9, 60.0), "check");
        assert_eq!(suggestion(40.0, 60.0), "check");
        assert_eq!(suggestion(39.9, 60.0), "retry");
        assert_eq!(sample_times(10.0, 5), vec![1.0, 3.0, 5.0, 7.0, 9.0]);
        assert_eq!(sample_times(4.0, 1), vec![2.0]);
        assert!(sample_times(3.0, 0).len() == 1);
    }

    #[test]
    fn still_image_detection() {
        let png = json!({ "hasVideo": true, "formatName": "png_pipe", "video": { "codec": "png" }, "durationSec": null });
        let jpg = json!({ "hasVideo": true, "formatName": "image2", "video": { "codec": "mjpeg" }, "durationSec": 0.04 });
        let mp4 = json!({ "hasVideo": true, "formatName": "mov,mp4,m4a,3gp,3g2,mj2", "video": { "codec": "h264" }, "durationSec": 5.0 });
        let gif_anim = json!({ "hasVideo": true, "formatName": "gif", "video": { "codec": "gif" }, "durationSec": 2.5 });
        let audio = json!({ "hasVideo": false, "formatName": "mp3" });
        assert!(is_still_image(&png) && is_still_image(&jpg) && is_still_image(&audio));
        assert!(!is_still_image(&mp4) && !is_still_image(&gif_anim));
        let v = crate::media::parse_probe(include_str!("fixtures/ffprobe_av.json")).unwrap();
        assert!(!is_still_image(&v));
    }

    #[test]
    fn blur_lowers_laplacian_variance() {
        let f = base(128);
        let g = f.luma();
        let sharp = laplacian_variance(&g, 128, 128);
        // 4x4 box blur via downsample + nearest upsample
        let small = downsample_gray(&g, 128, 128, 4);
        let mut blurred = vec![0u8; 128 * 128];
        for y in 0..128 {
            for x in 0..128 {
                blurred[y * 128 + x] = small[(y / 4) * 32 + x / 4];
            }
        }
        let soft = laplacian_variance(&blurred, 128, 128);
        assert!(sharp > 0.0 && soft < sharp, "sharp {sharp} soft {soft}");
        assert_eq!(laplacian_variance(&[1, 2, 3, 4], 2, 2), 0.0);
    }

    #[test]
    fn ranking_prefers_sharp_large_and_similar() {
        let c = |p: &str, w, h, s, sim| Candidate { path: p.into(), width: w, height: h, sharpness: s, similarity: sim };
        let r = rank(&[c("blurry", 2048, 2048, 10.0, None), c("sharp", 1024, 1024, 100.0, None), c("tiny", 128, 128, 100.0, None)]);
        assert_eq!(r.iter().map(|x| x["path"].as_str().unwrap()).collect::<Vec<_>>(), ["sharp", "tiny", "blurry"]);
        assert_eq!(r[0]["score"], 100.0);
        assert!(r[0]["similarity"].is_null());
        // with an anchor a much more similar candidate beats a sharper one
        let r = rank(&[c("sharp-different", 1024, 1024, 100.0, Some(20.0)), c("softer-similar", 1024, 1024, 60.0, Some(95.0))]);
        assert_eq!(r[0]["path"], "softer-similar");
        assert!(rank(&[]).is_empty());
        assert_eq!(rank(&[c("flat", 10, 10, 0.0, None)])[0]["score"], r1(0.35 * (10.0 / FULL_RES_SIDE) * 100.0));
    }

    #[test]
    fn frame_buffer_helpers() {
        assert!(Rgb::new(2, 2, vec![0; 11]).is_err());
        let f = Rgb::new(2, 2, vec![0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]).unwrap();
        let d = f.downsample(2);
        assert_eq!((d.w, d.h), (1, 1));
        assert_eq!(d.data, vec![128, 128, 128]);
        assert_eq!(f.luma(), vec![0, 255, 255, 0]);
        assert_eq!(downsample_gray(&[0, 255, 255, 0], 2, 2, 2), vec![128]);
    }

    #[tokio::test]
    async fn invalid_params() {
        assert_eq!(score(&json!({})).await.unwrap_err().code, crate::rpc::ERR_INVALID_PARAMS);
        assert_eq!(score(&json!({ "reference": "a.png" })).await.unwrap_err().code, crate::rpc::ERR_INVALID_PARAMS);
        assert_eq!(pick_reference(&json!({})).await.unwrap_err().code, crate::rpc::ERR_INVALID_PARAMS);
        assert_eq!(pick_reference(&json!({ "candidates": [] })).await.unwrap_err().code, crate::rpc::ERR_INVALID_PARAMS);
        assert_eq!(pick_reference(&json!({ "candidates": ["a", 1] })).await.unwrap_err().code, crate::rpc::ERR_INVALID_PARAMS);
    }

    fn real_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
            && std::process::Command::new("ffprobe").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn gen(args: &[&str]) {
        let st = std::process::Command::new("ffmpeg").args(["-hide_banner", "-loglevel", "error", "-y"]).args(args).status().unwrap();
        assert!(st.success(), "ffmpeg {args:?}");
    }

    #[tokio::test]
    async fn real_ffmpeg_end_to_end() {
        if !real_ffmpeg() {
            eprintln!("SKIP: no ffmpeg/ffprobe on PATH");
            return;
        }
        let dir = std::env::temp_dir().join(format!("lycore-consistency-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().to_string();
        gen(&["-f", "lavfi", "-i", "testsrc2=s=320x240:d=1", "-frames:v", "1", &p("ref.png")]);
        std::fs::copy(p("ref.png"), p("same.png")).unwrap();
        gen(&["-i", &p("ref.png"), "-vf", "hue=h=150:s=1.3", &p("shift.png")]);
        gen(&["-i", &p("ref.png"), "-vf", "boxblur=8", &p("blur.png")]);
        gen(&["-i", &p("ref.png"), "-vf", "scale=96:72", &p("small.png")]);
        gen(&["-f", "lavfi", "-i", "nullsrc=s=320x240,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255'", "-frames:v", "1", &p("noise.png")]);
        gen(&["-f", "lavfi", "-i", "testsrc2=s=320x240:r=10:d=1", "-pix_fmt", "yuv420p", &p("clip.mp4")]);

        let same = score(&json!({ "reference": p("ref.png"), "target": p("same.png") })).await.unwrap();
        assert_eq!(same["score"], 100.0);
        assert_eq!(same["kind"], "image");
        assert_eq!(same["suggestion"], "ok");
        assert_eq!(same["frames"].as_array().unwrap().len(), 1);
        let shift = score(&json!({ "reference": p("ref.png"), "target": p("shift.png") })).await.unwrap()["score"].as_f64().unwrap();
        let rnd = score(&json!({ "reference": p("ref.png"), "target": p("noise.png"), "min_score": 60 })).await.unwrap();
        let rnd_score = rnd["score"].as_f64().unwrap();
        assert!(shift < 100.0 && shift > rnd_score, "shift {shift} noise {rnd_score}");
        assert!(rnd_score < 45.0, "noise {rnd_score}");
        assert_eq!(rnd["suggestion"], "retry");

        let clip = score(&json!({ "reference": p("ref.png"), "target": p("clip.mp4"), "sample_frames": 3 })).await.unwrap();
        assert_eq!(clip["kind"], "video");
        let frames = clip["frames"].as_array().unwrap();
        assert_eq!(frames.len(), 3);
        let ts: Vec<i64> = frames.iter().map(|f| f["t_ms"].as_i64().unwrap()).collect();
        assert!(ts.windows(2).all(|w| w[0] < w[1]) && ts[0] >= 0 && ts[2] < 1000, "{ts:?}");
        assert!(clip["score"].as_f64().unwrap() > 0.0);

        let missing = score(&json!({ "reference": p("ref.png"), "target": p("nope.png") })).await.unwrap_err();
        assert_eq!(missing.code, ffmpeg::ERR_FFMPEG_FAILED);

        let pick = pick_reference(&json!({ "candidates": [p("blur.png"), p("same.png"), p("small.png"), p("nope.png"), p("same.png")], "anchor": p("ref.png") })).await.unwrap();
        let ranked = pick["ranked"].as_array().unwrap();
        assert_eq!(ranked.len(), 3, "{pick}");
        assert_eq!(ranked[0]["path"], p("same.png"));
        assert_eq!(ranked[0]["width"], 320);
        assert_eq!(ranked[0]["similarity"], 100.0);
        assert!(ranked.iter().any(|r| r["path"] == p("blur.png") && r["sharpness"].as_f64().unwrap() < ranked[0]["sharpness"].as_f64().unwrap()));
        assert_eq!(pick["skipped"].as_array().unwrap().len(), 1);
        let no_anchor = pick_reference(&json!({ "candidates": [p("blur.png"), p("ref.png")] })).await.unwrap();
        assert_eq!(no_anchor["ranked"][0]["path"], p("ref.png"));
        assert!(no_anchor["ranked"][0]["similarity"].is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
