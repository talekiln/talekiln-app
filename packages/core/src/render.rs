//! render.start / render.status / render.cancel: async render jobs driving ffmpeg.
//! Pipeline: plan -> per-scene uniform segments in the cache -> concat (stream copy)
//! -> music mix with ducking + loudnorm -> atomic rename to the output path.

use crate::ffmpeg::{self, FfError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, watch};

pub const ERR_SUBTITLES_UNAVAILABLE: i64 = -32030;
pub const ERR_MISSING_ASSETS: i64 = -32031;
pub const ERR_RENDER_FAILED: i64 = -32032;
pub const ERR_UNKNOWN_JOB: i64 = -32602;

pub const SAMPLE_RATE: u32 = 48000;

// ---------------------------------------------------------------- notifications

fn bus() -> &'static broadcast::Sender<Value> {
    static B: OnceLock<broadcast::Sender<Value>> = OnceLock::new();
    B.get_or_init(|| broadcast::channel(256).0)
}

/// Subscribe to server-pushed JSON-RPC notifications (render.progress).
pub fn subscribe() -> broadcast::Receiver<Value> {
    bus().subscribe()
}

// ---------------------------------------------------------------- jobs

pub struct Job {
    pub id: String,
    state: Mutex<Value>,
    cancel: watch::Sender<bool>,
}

fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    static J: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

impl Job {
    fn snapshot(&self) -> Value {
        self.state.lock().unwrap().clone()
    }
    fn update(&self, f: impl FnOnce(&mut Value)) -> Value {
        let mut s = self.state.lock().unwrap();
        f(&mut s);
        s.clone()
    }
    fn notify(&self) {
        let _ = bus().send(json!({ "jsonrpc": "2.0", "method": "render.progress", "params": self.snapshot() }));
    }
    fn set_stage(&self, stage: &str) {
        self.update(|s| s["stage"] = json!(stage));
        self.notify();
    }
    fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }
    fn is_final(&self) -> bool {
        matches!(self.snapshot()["status"].as_str(), Some("done" | "failed" | "cancelled"))
    }
}

// ---------------------------------------------------------------- pure argument builders

#[derive(Clone, Debug)]
pub struct OutSpec {
    pub w: i64,
    pub h: i64,
    pub fps_milli: i64,
}

impl OutSpec {
    fn fps(&self) -> String {
        format!("{}/1000", self.fps_milli)
    }
}

/// Seconds string with millisecond precision.
pub fn secs(ms: i64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

fn gain_str(units: i64) -> String {
    format!("{:.4}", units as f64 / 10000.0)
}

/// Video encoder arguments. Identical across all scenes of one render so the segments concat cleanly.
pub fn encoder_args(enc: &str, out: &OutSpec) -> Vec<String> {
    let mut a: Vec<String> = vec!["-c:v".into(), enc.into()];
    let extra: &[&str] = match enc {
        "libx264" => &["-preset", "veryfast", "-crf", "20"],
        "h264_nvenc" => &["-preset", "p4", "-rc", "vbr", "-cq", "21", "-b:v", "0"],
        "h264_qsv" => &["-preset", "medium", "-global_quality", "21"],
        "h264_amf" => &["-quality", "balanced", "-rc", "cqp", "-qp_i", "21", "-qp_p", "21"],
        "h264_mf" => &["-b:v", "10M"],
        // macOS VideoToolbox: bitrate-driven; `-allow_sw 0` keeps it on the hardware engine (a software
        // fallback would be slower than libx264-free LGPL builds can afford and hides detect results).
        "h264_videotoolbox" => &["-b:v", "10M", "-allow_sw", "0"],
        _ => &[],
    };
    a.extend(extra.iter().map(|s| s.to_string()));
    let gop = ((out.fps_milli as f64 / 1000.0) * 2.0).round().max(1.0) as i64;
    a.extend(["-g", &gop.to_string(), "-pix_fmt", "yuv420p"].iter().map(|s| s.to_string()));
    a
}

#[derive(Clone, Debug)]
pub struct VideoIn {
    pub path: String,
    pub is_image: bool,
    pub src_in_ms: i64,
    pub gain: i64,
    pub has_audio: bool,
}
#[derive(Clone, Debug)]
pub struct Cue {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub style: Value,
}
#[derive(Clone, Debug)]
pub struct NarrIn {
    pub rel_ms: i64,
    pub dur_ms: i64,
    pub path: String,
    pub src_in_ms: i64,
    pub gain: i64,
}
#[derive(Clone, Debug)]
pub struct SceneSpec {
    pub dur_ms: i64,
    pub video: Option<VideoIn>,
    pub cues: Vec<Cue>,
    pub narr: Vec<NarrIn>,
}

impl SceneSpec {
    /// Parse a scene object of the render.plan result (uses its `detail`).
    pub fn from_plan(scene: &Value) -> Result<SceneSpec, String> {
        let dur_ms = scene["durationMs"].as_i64().ok_or("scene without durationMs")?;
        let d = &scene["detail"];
        let video = if d["video"].is_object() {
            let v = &d["video"];
            Some(VideoIn {
                path: v["assetRef"].as_str().ok_or("video scene without assetRef")?.to_string(),
                is_image: v["assetKind"].as_str() == Some("image"),
                src_in_ms: v["srcInMs"].as_i64().unwrap_or(0),
                gain: v["gain"].as_i64().unwrap_or(10000),
                has_audio: false,
            })
        } else {
            None
        };
        let cues = d["subtitles"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| Cue {
                        start_ms: c["relStartMs"].as_i64().unwrap_or(0),
                        end_ms: c["relEndMs"].as_i64().unwrap_or(0),
                        text: c["text"].as_str().unwrap_or("").to_string(),
                        style: c["style"].clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let narr = d["narration"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|n| {
                        Some(NarrIn {
                            rel_ms: n["relStartMs"].as_i64()?,
                            dur_ms: n["durMs"].as_i64()?,
                            path: n["assetRef"].as_str()?.to_string(),
                            src_in_ms: n["srcInMs"].as_i64().unwrap_or(0),
                            gain: n["gain"].as_i64().unwrap_or(10000),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(SceneSpec { dur_ms, video, cues, narr })
    }
}

fn ass_time(ms: i64) -> String {
    let cs = ms / 10;
    format!("{}:{:02}:{:02}.{:02}", cs / 360000, (cs / 6000) % 60, (cs / 100) % 60, cs % 100)
}

/// "#RRGGBB" -> ASS "&H00BBGGRR".
fn ass_color(v: Option<&Value>, default: &str) -> String {
    let s = v.and_then(|x| x.as_str()).unwrap_or(default).trim_start_matches('#');
    let s = if s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit()) { s } else { default.trim_start_matches('#') };
    format!("&H00{}{}{}", &s[4..6], &s[2..4], &s[0..2]).to_uppercase()
}

fn ass_escape(t: &str) -> String {
    t.replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace("\r\n", "\\N")
        .replace('\n', "\\N")
}

/// Style fields (all optional): font, size (px at output height), color, outlineColor, outline,
/// bold, position (bottom|middle|top), marginV. A JSON-string style is parsed first.
pub fn ass_content(cues: &[Cue], out: &OutSpec) -> String {
    let mut styles: Vec<(String, Value)> = vec![];
    let mut lines = String::new();
    for c in cues {
        let st = match &c.style {
            Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
            v => v.clone(),
        };
        let key = crate::plan::canonical_string(&st);
        let idx = match styles.iter().position(|(k, _)| *k == key) {
            Some(i) => i,
            None => {
                styles.push((key, st));
                styles.len() - 1
            }
        };
        lines.push_str(&format!(
            "Dialogue: 0,{},{},S{},,0,0,0,,{}\n",
            ass_time(c.start_ms),
            ass_time(c.end_ms),
            idx,
            ass_escape(&c.text)
        ));
    }
    let mut s = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {}\nPlayResY: {}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n",
        out.w, out.h
    );
    for (i, (_, st)) in styles.iter().enumerate() {
        let font = st.get("font").and_then(|f| f.as_str()).unwrap_or("Arial");
        let size = st.get("size").and_then(|f| f.as_f64()).unwrap_or(out.h as f64 / 18.0).round() as i64;
        let outline = st.get("outline").and_then(|f| f.as_f64()).unwrap_or(2.0);
        let bold = if st.get("bold").and_then(|b| b.as_bool()).unwrap_or(false) { -1 } else { 0 };
        let align = match st.get("position").and_then(|p| p.as_str()) {
            Some("top") => 8,
            Some("middle") => 5,
            _ => 2,
        };
        let margin_v = st.get("marginV").and_then(|f| f.as_i64()).unwrap_or(out.h / 20);
        s.push_str(&format!(
            "Style: S{i},{font},{size},{},{},{},&H80000000,{bold},0,0,0,100,100,0,0,1,{outline},0,{align},20,20,{margin_v},1\n",
            ass_color(st.get("color"), "#FFFFFF"),
            ass_color(st.get("color"), "#FFFFFF"),
            ass_color(st.get("outlineColor"), "#000000"),
        ));
    }
    s.push_str("\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
    s.push_str(&lines);
    s
}

/// Arguments to render one scene into `tmp_out` (muxer forced to mp4 so any temp name works).
/// `ass_name` is a bare file name relative to ffmpeg's working directory (avoids filter path escaping).
#[cfg_attr(not(test), allow(dead_code))]
pub fn scene_args(sc: &SceneSpec, out: &OutSpec, enc: &str, ass_name: Option<&str>, tmp_out: &str) -> Vec<String> {
    scene_args_ex(sc, out, enc, ass_name, None, tmp_out)
}

/// Escape a value for use inside a filtergraph option (two levels: option parser, then graph parser).
/// Needed for absolute paths such as a Windows `C:\fonts` (colon, backslash) or a macOS path with `'` / `,`.
pub fn filter_escape(v: &str) -> String {
    let l1: String = v.chars().fold(String::new(), |mut a, c| {
        if matches!(c, '\\' | ':' | '\'') {
            a.push('\\');
        }
        a.push(c);
        a
    });
    l1.chars().fold(String::new(), |mut a, c| {
        if matches!(c, '\\' | '\'' | '[' | ']' | ',' | ';') {
            a.push('\\');
        }
        a.push(c);
        a
    })
}

/// `scene_args` plus an optional libass font directory (bundled CJK fonts so subtitles look the same on
/// every OS instead of depending on which system fonts libass can see).
pub fn scene_args_ex(sc: &SceneSpec, out: &OutSpec, enc: &str, ass_name: Option<&str>, fonts_dir: Option<&str>, tmp_out: &str) -> Vec<String> {
    let s = |x: &str| x.to_string();
    let dur = secs(sc.dur_ms);
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"].iter().map(|x| s(x)).collect();
    // input 0: picture
    match &sc.video {
        Some(v) if v.is_image => a.extend([s("-loop"), s("1"), s("-framerate"), out.fps(), s("-t"), dur.clone(), s("-i"), v.path.clone()]),
        Some(v) => a.extend([s("-ss"), secs(v.src_in_ms), s("-t"), dur.clone(), s("-i"), v.path.clone()]),
        None => a.extend([
            s("-f"),
            s("lavfi"),
            s("-i"),
            format!("color=c=black:s={}x{}:r={}:d={}", out.w, out.h, out.fps(), dur),
        ]),
    }
    // input 1: silence base
    a.extend([s("-f"), s("lavfi"), s("-t"), dur.clone(), s("-i"), format!("anullsrc=r={SAMPLE_RATE}:cl=stereo")]);
    for n in &sc.narr {
        a.extend([s("-ss"), secs(n.src_in_ms), s("-t"), secs(n.dur_ms), s("-i"), n.path.clone()]);
    }
    // filters
    let mut vf = format!(
        "[0:v]fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration={dur}",
        fps = out.fps(),
        w = out.w,
        h = out.h,
    );
    if let Some(n) = ass_name {
        vf.push_str(&format!(",subtitles=filename={n}"));
        if let Some(d) = fonts_dir {
            vf.push_str(&format!(":fontsdir={}", filter_escape(d)));
        }
    }
    vf.push_str(",setpts=PTS-STARTPTS[v]");
    let mut parts = vec![vf];
    let mut labels = vec![s("[a0]")];
    parts.push(format!("[1:a]aresample={SAMPLE_RATE},asetpts=PTS-STARTPTS[a0]"));
    if let Some(v) = sc.video.as_ref().filter(|v| v.has_audio && !v.is_image) {
        parts.push(format!(
            "[0:a]aresample={SAMPLE_RATE},aformat=channel_layouts=stereo,volume={},asetpts=PTS-STARTPTS[av]",
            gain_str(v.gain)
        ));
        labels.push(s("[av]"));
    }
    for (i, n) in sc.narr.iter().enumerate() {
        let idx = i + 2;
        parts.push(format!(
            "[{idx}:a]aresample={SAMPLE_RATE},aformat=channel_layouts=stereo,volume={},adelay={ms}|{ms},asetpts=PTS-STARTPTS[an{i}]",
            gain_str(n.gain),
            ms = n.rel_ms
        ));
        labels.push(format!("[an{i}]"));
    }
    parts.push(format!("{}amix=inputs={}:duration=first:normalize=0[a]", labels.concat(), labels.len()));
    a.extend([s("-filter_complex"), parts.join(";")]);
    a.extend([s("-map"), s("[v]"), s("-map"), s("[a]"), s("-t"), dur]);
    a.extend(encoder_args(enc, out));
    a.extend(
        ["-r", &out.fps(), "-video_track_timescale", "90000", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
         "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-f", "mp4", tmp_out]
            .iter()
            .map(|x| s(x)),
    );
    a
}

#[derive(Clone, Debug)]
pub struct MusicIn {
    pub start_ms: i64,
    pub dur_ms: i64,
    pub path: String,
    pub src_in_ms: i64,
    pub gain: i64,
}

#[derive(Clone, Debug)]
pub struct Mix {
    pub music: Vec<MusicIn>,
    /// Absolute narration intervals (ms) the music is ducked under.
    pub duck: Vec<(i64, i64)>,
    pub duck_gain: f64,
    pub ramp_ms: i64,
    pub loudnorm: bool,
    pub total_ms: i64,
}

/// Merge overlapping/adjacent intervals.
pub fn merge_intervals(mut v: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    v.sort();
    let mut out: Vec<(i64, i64)> = vec![];
    for (a, b) in v {
        match out.last_mut() {
            Some(l) if a <= l.1 => l.1 = l.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

/// Volume-automation expression: product of per-interval trapezoids that dip to `gain` inside each interval.
pub fn duck_expr(intervals: &[(i64, i64)], gain: f64, ramp_ms: i64) -> String {
    let r = format!("{:.3}", ramp_ms.max(1) as f64 / 1000.0);
    let terms: Vec<String> = intervals
        .iter()
        .map(|(a, b)| {
            format!(
                "(1-(1-{gain:.3})*clip(min((t-{})/{r},({}-t)/{r}),0,1))",
                secs(*a),
                secs(*b)
            )
        })
        .collect();
    terms.join("*")
}

/// Final stage: concat list (input 0, stream copy video) + music inputs; audio mixed, ducked, normalised.
pub fn final_args(list: &str, mix: &Mix, tmp_out: &str) -> Vec<String> {
    let s = |x: &str| x.to_string();
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i"]
        .iter()
        .map(|x| s(x))
        .collect();
    a.push(s(list));
    for m in &mix.music {
        a.extend([s("-i"), m.path.clone()]);
    }
    let ln = if mix.loudnorm { format!("loudnorm=I=-16:TP=-1.5:LRA=11,aresample={SAMPLE_RATE}") } else { format!("aresample={SAMPLE_RATE}") };
    let mut parts: Vec<String> = vec![];
    if mix.music.is_empty() {
        parts.push(format!("[0:a]{ln}[a]"));
    } else {
        let mut labels = String::new();
        for (i, m) in mix.music.iter().enumerate() {
            parts.push(format!(
                "[{}:a]atrim=start={}:duration={},asetpts=PTS-STARTPTS,aresample={SAMPLE_RATE},aformat=channel_layouts=stereo,volume={},adelay={ms}|{ms}[m{i}]",
                i + 1,
                secs(m.src_in_ms),
                secs(m.dur_ms),
                gain_str(m.gain),
                ms = m.start_ms
            ));
            labels.push_str(&format!("[m{i}]"));
        }
        parts.push(format!("{labels}amix=inputs={}:duration=longest:normalize=0[mm]", mix.music.len()));
        let duck = merge_intervals(mix.duck.clone());
        if duck.is_empty() {
            parts.push("[mm]anull[md]".into());
        } else {
            parts.push(format!("[mm]volume='{}':eval=frame[md]", duck_expr(&duck, mix.duck_gain, mix.ramp_ms)));
        }
        parts.push(format!("[0:a][md]amix=inputs=2:duration=first:normalize=0,{ln}[a]"));
    }
    a.extend([s("-filter_complex"), parts.join(";")]);
    a.extend(["-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"].iter().map(|x| s(x)));
    a.extend(["-t", &secs(mix.total_ms), "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-f", "mp4", tmp_out].iter().map(|x| s(x)));
    a
}

/// Escape a path for the concat demuxer list file.
pub fn concat_line(p: &str) -> String {
    concat_line_for(p, cfg!(windows))
}

/// Only on Windows is `\` a path separator that may be flipped to `/`; on macOS/Linux it is a legal
/// file-name character and rewriting it would point the concat list at a different file.
pub fn concat_line_for(p: &str, windows: bool) -> String {
    let p = if windows { p.replace('\\', "/") } else { p.to_string() };
    // the concat demuxer's own quoting: a backslash inside single quotes is literal, only ' needs closing/reopening
    format!("file '{}'\n", p.replace('\'', "'\\''"))
}

/// Font directory for libass: request param `fontsDir`, env LYCORE_FONTS_DIR, else `<exe dir>/fonts` when present.
pub fn resolve_fonts_dir(param: Option<&str>, env: Option<&str>, exe_dir_fonts: Option<&Path>) -> Option<String> {
    param
        .filter(|s| !s.is_empty())
        .or(env.filter(|s| !s.is_empty()))
        .map(|s| s.to_string())
        .or_else(|| exe_dir_fonts.filter(|d| d.is_dir()).map(|d| d.to_string_lossy().into_owned()))
}

// ---------------------------------------------------------------- process runner

enum RunErr {
    Cancelled,
    Failed { code: Option<i32>, stderr: String },
    Ff(FfError),
}

async fn run_ff(
    job: &Job,
    exe: &Path,
    args: &[String],
    cwd: Option<&Path>,
    mut on_progress: impl FnMut(f64),
) -> Result<(), RunErr> {
    if job.cancelled() {
        return Err(RunErr::Cancelled);
    }
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| {
        RunErr::Ff(if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied) {
            FfError::missing("ffmpeg", &exe.display().to_string())
        } else {
            FfError::failed(format!("failed to start ffmpeg: {e}"), "", None)
        })
    })?;
    let mut se = child.stderr.take().expect("piped");
    let err_task = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = se.read_to_end(&mut b).await;
        String::from_utf8_lossy(&b).into_owned()
    });
    let mut lines = BufReader::new(child.stdout.take().expect("piped")).lines();
    let mut cancel = job.cancel.subscribe();
    if *cancel.borrow() {
        let _ = child.kill().await;
        return Err(RunErr::Cancelled);
    }
    loop {
        tokio::select! {
            _ = cancel.changed() => {
                if *cancel.borrow() {
                    let _ = child.kill().await;
                    err_task.abort();
                    return Err(RunErr::Cancelled);
                }
            }
            l = lines.next_line() => match l {
                Ok(Some(l)) => {
                    // out_time_us and (misnamed) out_time_ms are both microseconds.
                    if let Some(v) = l.strip_prefix("out_time_us=").or_else(|| l.strip_prefix("out_time_ms=")) {
                        if let Ok(us) = v.trim().parse::<f64>() { on_progress((us / 1e6).max(0.0)); }
                    }
                }
                _ => break,
            }
        }
    }
    let st = tokio::select! {
        st = child.wait() => st,
        _ = async { loop { if cancel.changed().await.is_err() || *cancel.borrow() { break; } } } => {
            let _ = child.kill().await;
            err_task.abort();
            return Err(RunErr::Cancelled);
        }
    };
    let stderr = err_task.await.unwrap_or_default();
    match st {
        Ok(st) if st.success() => Ok(()),
        Ok(st) => Err(RunErr::Failed { code: st.code(), stderr }),
        Err(e) => Err(RunErr::Ff(FfError::failed(format!("ffmpeg wait failed: {e}"), "", None))),
    }
}

// ---------------------------------------------------------------- job driver

struct Ctx {
    job: Arc<Job>,
    ffmpeg: PathBuf,
    ffprobe: Option<PathBuf>,
    params: Value,
    ffmpeg_dir: Option<String>,
}

enum Fail {
    Cancelled,
    /// Not worth retrying or falling back (bad input, missing tool, no libass).
    Fatal(FfError),
    /// ffmpeg exited non-zero.
    Encode { message: String, stderr: String },
}

fn out_spec(params: &Value) -> Result<(OutSpec, String), String> {
    let o = params.get("output").or_else(|| params.get("timeline").and_then(|t| t.get("output"))).ok_or("params.output is required")?;
    let w = o.get("width").and_then(|x| x.as_i64()).ok_or("output.width")?;
    let h = o.get("height").and_then(|x| x.as_i64()).ok_or("output.height")?;
    let fps = o.get("fps").and_then(|x| x.as_f64()).ok_or("output.fps")?;
    if w <= 0 || h <= 0 || fps <= 0.0 || w % 2 != 0 || h % 2 != 0 {
        return Err("output width/height must be positive even numbers and fps positive".into());
    }
    let enc = o.get("encoder").and_then(|e| e.as_str()).unwrap_or("libx264").to_string();
    Ok((OutSpec { w, h, fps_milli: (fps * 1000.0).round() as i64 }, enc))
}

async fn has_audio(ctx: &Ctx, path: &str) -> bool {
    let Some(p) = &ctx.ffprobe else { return true };
    let args: Vec<String> = ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", "-i", path]
        .iter()
        .map(|s| s.to_string())
        .collect();
    match ffmpeg::run(p, "ffprobe", &args, 30).await {
        Ok(o) => o.status_ok && !o.stdout.trim().is_empty(),
        Err(_) => true,
    }
}

async fn subtitles_filter_available(ctx: &Ctx) -> bool {
    let args: Vec<String> = ["-hide_banner", "-filters"].iter().map(|s| s.to_string()).collect();
    match ffmpeg::run(&ctx.ffmpeg, "ffmpeg", &args, 30).await {
        Ok(o) => o.stdout.lines().any(|l| l.split_whitespace().nth(1) == Some("subtitles")),
        Err(_) => false,
    }
}

struct Progress {
    total: f64,
    done: f64,
    last_pct: f64,
}

impl Progress {
    fn report(&mut self, job: &Job, cur_secs_weight_ms: f64, force: bool) {
        let pct = ((self.done + cur_secs_weight_ms) / self.total * 100.0).clamp(0.0, 99.5);
        if force || pct - self.last_pct >= 0.5 {
            self.last_pct = pct;
            job.update(|s| s["percent"] = json!((pct * 10.0).round() / 10.0));
            job.notify();
        }
    }
}

fn remove_quiet(p: &Path) {
    let _ = std::fs::remove_file(p);
}

/// One full attempt with one encoder: plan, render missing segments, concat+mix.
async fn attempt(ctx: &Ctx, enc: &str) -> Result<Value, Fail> {
    let job = &ctx.job;
    let (out, _) = out_spec(&ctx.params).map_err(|m| Fail::Fatal(bad_params(m)))?;
    let mut p = ctx.params.clone();
    p["output"] = {
        let mut o = p.get("output").or_else(|| p["timeline"].get("output")).cloned().unwrap_or(json!({}));
        o["encoder"] = json!(enc);
        o
    };
    let planp = p.clone();
    let plan = tokio::task::spawn_blocking(move || crate::plan::plan(&planp))
        .await
        .map_err(|e| Fail::Fatal(bad_params(e.to_string())))?
        .map_err(|m| Fail::Fatal(bad_params(m)))?;
    let missing: Vec<Value> = plan["missingAssets"].as_array().cloned().unwrap_or_default();
    if !missing.is_empty() {
        return Err(Fail::Fatal(FfError {
            code: ERR_MISSING_ASSETS,
            message: format!("{} source file(s) are missing", missing.len()),
            data: Some(json!({ "reason": "missing_assets", "missingAssets": missing })),
        }));
    }
    let music: Vec<MusicIn> = plan["music"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    Some(MusicIn {
                        start_ms: m["startMs"].as_i64()?,
                        dur_ms: m["durationMs"].as_i64()?,
                        path: m["assetRef"].as_str()?.to_string(),
                        src_in_ms: m["srcInMs"].as_i64().unwrap_or(0),
                        gain: m["gain"].as_i64().unwrap_or(10000),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let miss_music: Vec<Value> = music.iter().filter(|m| !Path::new(&m.path).is_file()).map(|m| json!(m.path)).collect();
    if !miss_music.is_empty() {
        return Err(Fail::Fatal(FfError {
            code: ERR_MISSING_ASSETS,
            message: "music source file is missing".into(),
            data: Some(json!({ "reason": "missing_assets", "missingAssets": miss_music })),
        }));
    }
    let total_ms = plan["durationMs"].as_i64().unwrap_or(0);
    if total_ms <= 0 {
        return Err(Fail::Fatal(bad_params("timeline is empty".into())));
    }
    let scenes = plan["scenes"].as_array().cloned().unwrap_or_default();
    let to_render: Vec<usize> = plan["toRender"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|x| x as usize)).collect()).unwrap_or_default();

    let cache = PathBuf::from(p["cacheDir"].as_str().unwrap_or("."));
    std::fs::create_dir_all(&cache).map_err(|e| Fail::Fatal(io_err("cannot create cacheDir", e)))?;
    let work = cache.join(format!(".tmp-{}", job.id));
    std::fs::create_dir_all(&work).map_err(|e| Fail::Fatal(io_err("cannot create temp dir", e)))?;
    let res = attempt_inner(ctx, enc, &out, &plan, &scenes, &to_render, &music, total_ms, &work, &cache, &p).await;
    let _ = std::fs::remove_dir_all(&work);
    res
}

fn bad_params(m: String) -> FfError {
    FfError { code: crate::rpc::ERR_INVALID_PARAMS, message: m, data: None }
}
fn io_err(what: &str, e: std::io::Error) -> FfError {
    FfError { code: ERR_RENDER_FAILED, message: format!("{what}: {e}"), data: Some(json!({ "reason": "io" })) }
}

fn map_run(e: RunErr, what: &str) -> Fail {
    match e {
        RunErr::Cancelled => Fail::Cancelled,
        RunErr::Ff(f) => Fail::Fatal(f),
        RunErr::Failed { code, stderr } => Fail::Encode {
            message: format!("ffmpeg failed while {what} (exit {})", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())),
            stderr,
        },
    }
}

#[allow(clippy::too_many_arguments)]
async fn attempt_inner(
    ctx: &Ctx,
    enc: &str,
    out: &OutSpec,
    plan: &Value,
    scenes: &[Value],
    to_render: &[usize],
    music: &[MusicIn],
    total_ms: i64,
    work: &Path,
    cache: &Path,
    p: &Value,
) -> Result<Value, Fail> {
    let job = &ctx.job;
    let seg_weight: f64 = to_render.iter().map(|&i| scenes[i]["durationMs"].as_f64().unwrap_or(0.0)).sum();
    let final_weight = (total_ms as f64 * 0.3).max(1.0);
    let mut prog = Progress { total: seg_weight + final_weight, done: 0.0, last_pct: -1.0 };
    prog.report(job, 0.0, true);

    let needs_subs = to_render.iter().any(|&i| scenes[i]["detail"]["subtitles"].as_array().map(|a| !a.is_empty()).unwrap_or(false));
    if needs_subs && !subtitles_filter_available(ctx).await {
        return Err(Fail::Fatal(FfError {
            code: ERR_SUBTITLES_UNAVAILABLE,
            message: "this ffmpeg build lacks the libass 'subtitles' filter; subtitles cannot be burned in (reinstall the bundled ffmpeg)".into(),
            data: Some(json!({ "reason": "subtitles_unavailable", "recoverable": true, "action": "reinstall", "tool": "ffmpeg" })),
        }));
    }

    job.set_stage("segments");
    for (n, &i) in to_render.iter().enumerate() {
        let scene = &scenes[i];
        let key = scene["sceneKey"].as_str().unwrap_or("").to_string();
        let mut spec = SceneSpec::from_plan(scene).map_err(|m| Fail::Fatal(bad_params(m)))?;
        if let Some(v) = spec.video.as_mut() {
            if !v.is_image {
                v.has_audio = has_audio(ctx, &v.path).await;
            }
        }
        let ass_name = if spec.cues.is_empty() {
            None
        } else {
            let name = format!("subs{i}.ass");
            std::fs::write(work.join(&name), ass_content(&spec.cues, out)).map_err(|e| Fail::Fatal(io_err("cannot write ASS file", e)))?;
            Some(name)
        };
        let tmp = cache.join(format!("{key}.{}.tmp", job.id));
        let fonts_dir = resolve_fonts_dir(
            ctx.params.get("fontsDir").and_then(|v| v.as_str()),
            std::env::var("LYCORE_FONTS_DIR").ok().as_deref(),
            std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("fonts"))).as_deref(),
        );
        let args = scene_args_ex(&spec, out, enc, ass_name.as_deref(), fonts_dir.as_deref(), &tmp.to_string_lossy());
        job.update(|s| s["stage"] = json!(format!("segment {}/{}", n + 1, to_render.len())));
        let dur_ms = spec.dur_ms as f64;
        let r = run_ff(job, &ctx.ffmpeg, &args, Some(work), |sec| {
            prog.report(job, (sec * 1000.0).min(dur_ms), false);
        })
        .await;
        if let Err(e) = r {
            remove_quiet(&tmp);
            return Err(map_run(e, &format!("rendering scene {i}")));
        }
        let dst = cache.join(format!("{key}.mp4"));
        if let Err(e) = std::fs::rename(&tmp, &dst) {
            remove_quiet(&tmp);
            return Err(Fail::Fatal(io_err("cannot move segment into cache", e)));
        }
        prog.done += dur_ms;
        prog.report(job, 0.0, true);
    }

    // concat list over all scenes (cache hits and fresh ones alike)
    let mut list = String::new();
    let mut duck = vec![];
    for sc in scenes {
        list.push_str(&concat_line(sc["cachePath"].as_str().unwrap_or("")));
        let start = sc["startMs"].as_i64().unwrap_or(0);
        for n in sc["detail"]["narration"].as_array().into_iter().flatten() {
            let a = start + n["relStartMs"].as_i64().unwrap_or(0);
            duck.push((a, a + n["durMs"].as_i64().unwrap_or(0)));
        }
    }
    let list_path = work.join("concat.txt");
    std::fs::write(&list_path, list).map_err(|e| Fail::Fatal(io_err("cannot write concat list", e)))?;
    let mix_cfg = p.get("mix").cloned().unwrap_or(Value::Null);
    let duck_on = mix_cfg["ducking"]["enabled"].as_bool().unwrap_or(true);
    let mix = Mix {
        music: music.to_vec(),
        duck: if duck_on { duck } else { vec![] },
        duck_gain: mix_cfg["ducking"]["gain"].as_f64().unwrap_or(0.25).clamp(0.0, 1.0),
        ramp_ms: mix_cfg["ducking"]["rampMs"].as_i64().unwrap_or(200),
        loudnorm: mix_cfg["loudnorm"].as_bool().unwrap_or(true),
        total_ms,
    };
    let out_path = PathBuf::from(p["outputPath"].as_str().unwrap_or("out.mp4"));
    if let Some(parent) = out_path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| Fail::Fatal(io_err("cannot create output directory", e)))?;
    }
    let tmp_out = PathBuf::from(format!("{}.{}.tmp", out_path.display(), job.id));
    let args = final_args(&list_path.to_string_lossy(), &mix, &tmp_out.to_string_lossy());
    job.set_stage("final");
    let r = run_ff(job, &ctx.ffmpeg, &args, None, |sec| {
        prog.report(job, (sec * 1000.0 / total_ms as f64).min(1.0) * final_weight, false);
    })
    .await;
    if let Err(e) = r {
        remove_quiet(&tmp_out);
        return Err(map_run(e, "mixing the final video"));
    }
    if job.cancelled() {
        remove_quiet(&tmp_out);
        return Err(Fail::Cancelled);
    }
    let _ = std::fs::remove_file(&out_path);
    std::fs::rename(&tmp_out, &out_path).map_err(|e| {
        remove_quiet(&tmp_out);
        Fail::Fatal(io_err("cannot move output into place", e))
    })?;
    Ok(json!({
        "outputPath": out_path.to_string_lossy(), "durationMs": total_ms, "encoder": enc,
        "scenesTotal": scenes.len(), "scenesRendered": to_render.len(),
        "scenesCached": scenes.len() - to_render.len(),
        "rendererVersion": plan["rendererVersion"],
    }))
}

/// Encoders to try after `first`: explicit `fallbackEncoders`, else encoder.detect's order, libx264 always last.
async fn fallback_list(ctx: &Ctx, first: &str) -> Vec<String> {
    let mut v: Vec<String> = match ctx.params.get("fallbackEncoders").and_then(|x| x.as_array()) {
        Some(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        None => {
            let mut p = json!({});
            if let Some(d) = &ctx.ffmpeg_dir {
                p["ffmpegDir"] = json!(d);
            }
            match crate::encoder::detect(&p).await {
                Ok(r) => r["recommended"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
                Err(_) => vec![],
            }
        }
    };
    v.retain(|e| e != first && e != "libx264");
    if first != "libx264" {
        v.push("libx264".into());
    }
    v
}

async fn run_job(ctx: Ctx) {
    let job = ctx.job.clone();
    let started = std::time::Instant::now();
    job.update(|s| s["status"] = json!("running"));
    job.notify();
    let (_, first) = out_spec(&ctx.params).unwrap_or((OutSpec { w: 0, h: 0, fps_milli: 0 }, "libx264".into()));
    let mut order = vec![first.clone()];
    let mut tried_fallbacks = false;
    let mut attempts: Vec<Value> = vec![];
    let mut i = 0;
    let mut last_err: Option<(String, String)> = None;
    while i < order.len() {
        let enc = order[i].clone();
        // a failed encoder gets exactly one retry with the same encoder, then we move on
        let mut outcome = None;
        for try_no in 1..=2 {
            job.update(|s| {
                s["encoder"] = json!(enc);
                s["attempt"] = json!(attempts.len() + 1);
            });
            match attempt(&ctx, &enc).await {
                Ok(r) => {
                    outcome = Some(Ok(r));
                    break;
                }
                Err(Fail::Cancelled) => {
                    outcome = Some(Err(None));
                    break;
                }
                Err(Fail::Fatal(e)) => {
                    outcome = Some(Err(Some(e)));
                    break;
                }
                Err(Fail::Encode { message, stderr }) => {
                    tracing::warn!(encoder = %enc, try_no, %message, "render attempt failed");
                    attempts.push(json!({ "encoder": enc, "try": try_no, "message": message, "stderr": ffmpeg::tail(&stderr, 600) }));
                    last_err = Some((message, stderr));
                }
            }
        }
        match outcome {
            Some(Ok(mut r)) => {
                r["attempts"] = json!(attempts);
                r["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
                job.update(|s| {
                    s["status"] = json!("done");
                    s["percent"] = json!(100.0);
                    s["stage"] = json!("done");
                    s["result"] = r;
                });
                job.notify();
                return;
            }
            Some(Err(None)) => {
                job.update(|s| {
                    s["status"] = json!("cancelled");
                    s["stage"] = json!("cancelled");
                });
                job.notify();
                return;
            }
            Some(Err(Some(e))) => {
                fail(&job, e);
                return;
            }
            None => {
                if !tried_fallbacks {
                    tried_fallbacks = true;
                    order.extend(fallback_list(&ctx, &first).await);
                }
                i += 1;
            }
        }
    }
    let (m, se) = last_err.unwrap_or_default();
    fail(
        &job,
        FfError {
            code: ERR_RENDER_FAILED,
            message: format!("render failed with every available encoder: {m}"),
            data: Some(json!({ "reason": "render_failed", "stderr": ffmpeg::tail(&se, 1000), "attempts": attempts })),
        },
    );
}

fn fail(job: &Job, e: FfError) {
    job.update(|s| {
        s["status"] = json!("failed");
        s["stage"] = json!("failed");
        s["error"] = json!({ "code": e.code, "message": e.message, "data": e.data });
    });
    job.notify();
}

// ---------------------------------------------------------------- RPC entry points

fn new_job_id() -> String {
    static N: AtomicU64 = AtomicU64::new(1);
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("job-{}-{}", ms, N.fetch_add(1, Ordering::Relaxed))
}

/// render.start: validates, spawns the job, returns `{jobId}` immediately.
pub async fn start(params: &Value) -> Result<Value, FfError> {
    for k in ["timeline", "cacheDir", "outputPath"] {
        if params.get(k).is_none() {
            return Err(bad_params(format!("params.{k} is required")));
        }
    }
    out_spec(params).map_err(bad_params)?;
    {
        // validate the timeline shape up front so errors are synchronous
        let p = params.clone();
        tokio::task::spawn_blocking(move || crate::plan::plan(&p)).await.map_err(|e| bad_params(e.to_string()))?.map_err(bad_params)?;
    }
    let dir = params.get("ffmpegDir").and_then(|d| d.as_str());
    let ffmpeg = ffmpeg::locate("ffmpeg", dir)?;
    let ffprobe = ffmpeg::locate("ffprobe", dir).ok();
    let (tx, _) = watch::channel(false);
    let job = Arc::new(Job {
        id: new_job_id(),
        state: Mutex::new(json!({})),
        cancel: tx,
    });
    job.update(|s| {
        *s = json!({ "jobId": job.id, "status": "queued", "percent": 0.0, "stage": "queued", "encoder": null, "error": null, "result": null });
    });
    jobs().lock().unwrap().insert(job.id.clone(), job.clone());
    let ctx = Ctx { job: job.clone(), ffmpeg, ffprobe, params: params.clone(), ffmpeg_dir: dir.map(String::from) };
    tokio::spawn(run_job(ctx));
    Ok(json!({ "jobId": job.id }))
}

fn find_job(params: &Value) -> Result<Arc<Job>, FfError> {
    let id = params.get("jobId").and_then(|j| j.as_str()).ok_or_else(|| bad_params("params.jobId is required".into()))?;
    jobs().lock().unwrap().get(id).cloned().ok_or_else(|| FfError {
        code: ERR_UNKNOWN_JOB,
        message: format!("unknown jobId: {id}"),
        data: None,
    })
}

pub fn status(params: &Value) -> Result<Value, FfError> {
    Ok(find_job(params)?.snapshot())
}

/// render.cancel: kills the running ffmpeg child; the job ends as `cancelled`. No-op on finished jobs.
pub fn cancel(params: &Value) -> Result<Value, FfError> {
    let job = find_job(params)?;
    if !job.is_final() {
        let _ = job.cancel.send(true);
    }
    Ok(json!({ "jobId": job.id, "status": job.snapshot()["status"], "cancelRequested": !job.is_final() }))
}

#[cfg(test)]
mod tests;
