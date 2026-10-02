use super::*;
use std::time::{Duration, Instant};

fn out() -> OutSpec {
    OutSpec { w: 640, h: 360, fps_milli: 25000 }
}

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lycore-render-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn pos(a: &[String], x: &str) -> usize {
    a.iter().position(|s| s == x).unwrap_or_else(|| panic!("{x} not in {a:?}"))
}

fn arg_after<'a>(a: &'a [String], x: &str) -> &'a str {
    &a[pos(a, x) + 1]
}

#[test]
fn encoder_args_per_encoder() {
    let a = encoder_args("libx264", &out());
    assert_eq!(arg_after(&a, "-c:v"), "libx264");
    assert_eq!(arg_after(&a, "-crf"), "20");
    assert_eq!(arg_after(&a, "-g"), "50");
    assert_eq!(arg_after(&a, "-pix_fmt"), "yuv420p");
    assert_eq!(arg_after(&encoder_args("h264_nvenc", &out()), "-cq"), "21");
    assert_eq!(arg_after(&encoder_args("h264_mf", &out()), "-b:v"), "10M");
    assert!(encoder_args("h264_amf", &out()).contains(&"-qp_i".to_string()));
    assert!(encoder_args("h264_qsv", &out()).contains(&"-global_quality".to_string()));
    // libopenh264 (LGPL build): ffmpeg's default 200 kbit/s target is far too low, so a bitrate is set
    assert_eq!(arg_after(&encoder_args("libopenh264", &out()), "-b:v"), "8M");
}

#[test]
fn fallback_order_keeps_software_last() {
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    // explicit list: hardware encoders in the given order, then every software encoder not already chosen
    assert_eq!(order_fallbacks(v(&["h264_qsv", "libx264", "h264_mf"]), "h264_nvenc"), v(&["h264_qsv", "h264_mf", "libx264", "libopenh264"]));
    // the first encoder is never retried; a software first encoder falls back to the other software one
    assert_eq!(order_fallbacks(v(&["h264_nvenc", "libx264"]), "libx264"), v(&["h264_nvenc", "libopenh264"]));
    assert_eq!(order_fallbacks(v(&[]), "libopenh264"), v(&["libx264"]));
}

#[test]
fn video_scene_args() {
    let sc = SceneSpec {
        dur_ms: 4000,
        video: Some(VideoIn { path: "/a/clip.mp4".into(), is_image: false, src_in_ms: 1500, gain: 5000, has_audio: true }),
        cues: vec![],
        narr: vec![NarrIn { rel_ms: 1000, dur_ms: 2000, path: "/a/n.wav".into(), src_in_ms: 250, gain: 8000 }],
    };
    let a = scene_args(&sc, &out(), "libx264", Some("subs0.ass"), "/c/k.tmp");
    assert_eq!(a[pos(&a, "-ss") + 1], "1.500");
    assert_eq!(a[pos(&a, "-ss") + 3], "4.000");
    let fc = arg_after(&a, "-filter_complex");
    assert!(fc.contains("scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2"), "{fc}");
    assert!(fc.contains("fps=25000/1000"));
    assert!(fc.contains("subtitles=filename=subs0.ass"));
    assert!(fc.contains("[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.5000"));
    assert!(fc.contains("[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.8000,adelay=1000|1000"));
    assert!(fc.contains("[a0][av][an0]amix=inputs=3:duration=first:normalize=0[a]"));
    assert_eq!(a.last().unwrap(), "/c/k.tmp");
    assert_eq!(a[a.len() - 2], "mp4");
    assert_eq!(arg_after(&a, "-ar"), "48000");
    assert_eq!(arg_after(&a, "-video_track_timescale"), "90000");
    assert!(a.contains(&"-progress".to_string()));
}

#[test]
fn gap_scene_is_black_and_silent() {
    let sc = SceneSpec { dur_ms: 1000, video: None, cues: vec![], narr: vec![] };
    let a = scene_args(&sc, &out(), "h264_nvenc", None, "t");
    assert_eq!(arg_after(&a, "-i"), "color=c=black:s=640x360:r=25000/1000:d=1.000");
    let fc = arg_after(&a, "-filter_complex");
    assert!(!fc.contains("subtitles"));
    assert!(fc.contains("[a0]amix=inputs=1"));
    assert_eq!(arg_after(&a, "-c:v"), "h264_nvenc");
}

#[test]
fn ass_generation() {
    let cues = vec![
        Cue { start_ms: 500, end_ms: 3723, text: "hi {x}\nbye".into(), style: json!("{\"size\":40,\"color\":\"#FF8000\",\"position\":\"top\"}") },
        Cue { start_ms: 4000, end_ms: 5000, text: "again".into(), style: json!({"size":40,"color":"#FF8000","position":"top"}) },
        Cue { start_ms: 6000, end_ms: 7000, text: "plain".into(), style: Value::Null },
    ];
    let s = ass_content(&cues, &out());
    assert!(s.contains("PlayResX: 640"));
    assert!(s.contains("Dialogue: 0,0:00:00.50,0:00:03.72,S0,,0,0,0,,hi \\{x\\}\\Nbye"), "{s}");
    assert!(s.contains("Dialogue: 0,0:00:04.00,0:00:05.00,S0,"), "string/object styles share one style");
    assert!(s.contains(",S1,,0,0,0,,plain"));
    assert!(s.contains("Style: S0,Arial,40,&H000080FF,"), "{s}");
    assert!(s.contains(",8,20,20,"));
    assert_eq!(s.matches("Style: S").count(), 2);
}

#[test]
fn duck_expression_and_merge() {
    assert_eq!(merge_intervals(vec![(5000, 6000), (0, 1000), (900, 2000)]), vec![(0, 2000), (5000, 6000)]);
    let e = duck_expr(&[(1000, 2000)], 0.25, 200);
    assert_eq!(e, "(1-(1-0.250)*clip(min((t-1.000)/0.200,(2.000-t)/0.200),0,1))");
    assert!(duck_expr(&[(0, 1000), (3000, 4000)], 0.5, 100).contains(")*(1-"));
}

#[test]
fn final_args_with_and_without_music() {
    let m = Mix {
        music: vec![MusicIn { start_ms: 500, dur_ms: 6000, path: "/m/song.mp3".into(), src_in_ms: 2000, gain: 5000 }],
        duck: vec![(1000, 2000)],
        duck_gain: 0.25,
        ramp_ms: 200,
        loudnorm: true,
        total_ms: 8000,
    };
    let a = final_args("/w/concat.txt", &m, "/o/x.tmp");
    assert_eq!(arg_after(&a, "-safe"), "0");
    let first_i = pos(&a, "-i");
    assert_eq!(a[first_i + 1], "/w/concat.txt");
    assert!(a.contains(&"/m/song.mp3".to_string()));
    let fc = arg_after(&a, "-filter_complex");
    assert!(fc.contains("atrim=start=2.000:duration=6.000"));
    assert!(fc.contains("volume=0.5000,adelay=500|500[m0]"));
    assert!(fc.contains("volume='(1-(1-0.250)*clip("));
    assert!(fc.contains("eval=frame[md]"));
    assert!(fc.contains("[0:a][md]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]"));
    assert_eq!(arg_after(&a, "-c:v"), "copy");
    assert_eq!(arg_after(&a, "-t"), "8.000");
    assert_eq!(a.last().unwrap(), "/o/x.tmp");

    let m2 = Mix { music: vec![], loudnorm: false, ..m };
    let a2 = final_args("l", &m2, "o");
    assert_eq!(arg_after(&a2, "-filter_complex"), "[0:a]aresample=48000[a]");
}

#[test]
fn concat_line_escapes() {
    assert_eq!(concat_line_for("C:\\a\\it's.mp4", true), "file 'C:/a/it'\\''s.mp4'\n");
}

#[test]
fn concat_line_keeps_backslash_on_unix() {
    // a backslash is a legal file-name character on macOS/Linux and must not become a separator
    assert_eq!(concat_line_for("/Users/a/we\\ird.mp4", false), "file '/Users/a/we\\ird.mp4'\n");
    assert_eq!(concat_line_for("/Users/a/it's.mp4", false), "file '/Users/a/it'\\''s.mp4'\n");
    assert_eq!(concat_line_for("/Users/张三/镜头 1.mp4", false), "file '/Users/张三/镜头 1.mp4'\n");
}

#[test]
fn videotoolbox_encoder_args() {
    let a = encoder_args("h264_videotoolbox", &out());
    assert_eq!(arg_after(&a, "-c:v"), "h264_videotoolbox");
    assert_eq!(arg_after(&a, "-b:v"), "10M");
    assert_eq!(arg_after(&a, "-allow_sw"), "0");
    assert_eq!(arg_after(&a, "-pix_fmt"), "yuv420p");
}

#[test]
fn filter_escape_two_levels() {
    assert_eq!(filter_escape("/Users/jo/My Fonts"), "/Users/jo/My Fonts");
    // C:\fonts -> option level C\:\\fonts -> graph level doubles every backslash
    assert_eq!(filter_escape(r"C:\fonts"), r"C\\:\\\\fonts");
    assert_eq!(filter_escape("/a,b;c[d]"), r"/a\,b\;c\[d\]");
    // ' is escaped at option level (\') and again at graph level (\\\')
    assert_eq!(filter_escape("/it's"), r"/it\\\'s");
}

#[test]
fn fonts_dir_resolution_order() {
    let d = tmpdir("fontsdir");
    assert_eq!(resolve_fonts_dir(Some("/p"), Some("/e"), Some(&d)).as_deref(), Some("/p"));
    assert_eq!(resolve_fonts_dir(Some(""), Some("/e"), Some(&d)).as_deref(), Some("/e"));
    assert_eq!(resolve_fonts_dir(None, None, Some(&d)), Some(d.to_string_lossy().into_owned()));
    assert_eq!(resolve_fonts_dir(None, None, Some(&d.join("missing"))), None);
    assert_eq!(resolve_fonts_dir(None, None, None), None);
}

#[test]
fn subtitles_filter_gets_fontsdir() {
    let sc = SceneSpec { dur_ms: 1000, video: None, cues: vec![], narr: vec![] };
    let a = scene_args_ex(&sc, &out(), "libx264", Some("subs0.ass"), Some("/Users/jo/My Fonts"), "t.tmp");
    let fc = arg_after(&a, "-filter_complex");
    assert!(fc.contains("subtitles=filename=subs0.ass:fontsdir=/Users/jo/My Fonts,"), "{fc}");
    let none = scene_args_ex(&sc, &out(), "libx264", Some("subs0.ass"), None, "t.tmp");
    assert!(!arg_after(&none, "-filter_complex").contains("fontsdir"));
}

// ------------------------------------------------------------ job-level tests

async fn wait_final(id: &str) -> Value {
    let t = Instant::now();
    loop {
        let s = status(&json!({ "jobId": id })).unwrap();
        if matches!(s["status"].as_str(), Some("done" | "failed" | "cancelled")) {
            return s;
        }
        assert!(t.elapsed() < Duration::from_secs(180), "job timed out: {s}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn timeline(dir: &Path, with_subs: bool) -> Value {
    let p = |n: &str| dir.join(n).to_string_lossy().to_string();
    let mut tracks = vec![
        json!({ "kind": "video", "volume": 1, "muted": false, "clips": [
            { "id": "v1", "start_ms": 0, "duration_ms": 2000, "src_in_ms": 500, "src_out_ms": 2500, "asset_ref": p("a.mp4"), "asset_kind": "video", "volume": 1 },
            { "id": "v2", "start_ms": 3000, "duration_ms": 1500, "src_in_ms": 0, "src_out_ms": 1500, "asset_ref": p("b.mp4"), "asset_kind": "video", "volume": 1 } ]}),
        json!({ "kind": "narration", "volume": 1, "clips": [
            { "id": "n1", "start_ms": 500, "duration_ms": 1500, "asset_ref": p("n.wav"), "volume": 1 } ]}),
        json!({ "kind": "music", "volume": 0.5, "clips": [
            { "id": "m1", "start_ms": 0, "duration_ms": 4500, "asset_ref": p("m.wav"), "volume": 1 } ]}),
    ];
    if with_subs {
        tracks.push(json!({ "kind": "subtitle", "clips": [
            { "id": "s1", "start_ms": 200, "duration_ms": 1000, "text": "Hello world", "style": {"size": 36} },
            { "id": "s2", "start_ms": 3200, "duration_ms": 1000, "text": "Second line" } ]}));
    }
    json!({ "tracks": tracks })
}

fn params(dir: &Path, tl: Value, encoder: &str, ffdir: Option<&Path>) -> Value {
    let mut p = json!({
        "timeline": tl,
        "output": { "width": 320, "height": 180, "fps": 25, "encoder": encoder },
        "cacheDir": dir.join("cache").to_string_lossy(),
        "outputPath": dir.join("out/final.mp4").to_string_lossy(),
    });
    if let Some(d) = ffdir {
        p["ffmpegDir"] = json!(d.to_string_lossy());
    }
    p
}

fn real_ffmpeg() -> bool {
    std::process::Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
        && std::process::Command::new("ffprobe").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
}

fn gen(dir: &Path) {
    let run = |args: &[&str]| {
        let st = std::process::Command::new("ffmpeg").args(["-hide_banner", "-loglevel", "error", "-y"]).args(args).status().unwrap();
        assert!(st.success());
    };
    let d = |n: &str| dir.join(n).to_string_lossy().to_string();
    // a: 640x360 with audio; b: 4:3, no audio (forces pad)
    run(&["-f", "lavfi", "-i", "testsrc=s=640x360:r=30:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-shortest", "-pix_fmt", "yuv420p", &d("a.mp4")]);
    run(&["-f", "lavfi", "-i", "testsrc2=s=320x240:r=24:d=3", "-pix_fmt", "yuv420p", &d("b.mp4")]);
    run(&["-f", "lavfi", "-i", "sine=f=880:d=3", &d("n.wav")]);
    run(&["-f", "lavfi", "-i", "sine=f=220:d=6", &d("m.wav")]);
}

fn probe(path: &Path, entries: &str) -> Vec<String> {
    let o = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", entries, "-of", "default=nw=1:nk=1"])
        .arg(path)
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout).lines().map(String::from).collect()
}

async fn run_to_end(p: &Value) -> Value {
    let id = start(p).await.unwrap()["jobId"].as_str().unwrap().to_string();
    wait_final(&id).await
}

#[tokio::test]
async fn real_ffmpeg_end_to_end_with_cache() {
    if !real_ffmpeg() {
        eprintln!("SKIP: no ffmpeg/ffprobe on PATH");
        return;
    }
    let dir = tmpdir("e2e");
    gen(&dir);
    let tl = timeline(&dir, true);
    let s = run_to_end(&params(&dir, tl.clone(), "libx264", None)).await;
    assert_eq!(s["status"], "done", "{s}");
    assert_eq!(s["percent"], 100.0);
    assert_eq!(s["result"]["scenesTotal"], 3);
    assert_eq!(s["result"]["scenesRendered"], 3);
    let outp = dir.join("out/final.mp4");
    let w = probe(&outp, "stream=codec_name,width,height");
    assert!(w.contains(&"h264".to_string()) && w.contains(&"320".to_string()) && w.contains(&"180".to_string()), "{w:?}");
    assert!(w.contains(&"aac".to_string()), "{w:?}");
    let dur: f64 = probe(&outp, "format=duration")[0].parse().unwrap();
    assert!((dur - 4.5).abs() < 0.25, "duration {dur}");
    let cached: Vec<_> = std::fs::read_dir(dir.join("cache")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    assert_eq!(cached.iter().filter(|n| n.ends_with(".mp4")).count(), 3, "{cached:?}");
    assert!(cached.iter().all(|n| !n.contains("tmp")), "{cached:?}");
    assert!(std::fs::read_dir(dir.join("out")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains("tmp")));

    let s2 = run_to_end(&params(&dir, tl.clone(), "libx264", None)).await;
    assert_eq!(s2["status"], "done", "{s2}");
    assert_eq!(s2["result"]["scenesRendered"], 0);
    assert_eq!(s2["result"]["scenesCached"], 3);

    // music volume only changes the final mix
    let mut tl3 = tl.clone();
    tl3["tracks"][2]["volume"] = json!(0.2);
    let s3 = run_to_end(&params(&dir, tl3, "libx264", None)).await;
    assert_eq!(s3["result"]["scenesRendered"], 0, "{s3}");
    // a subtitle edit re-renders exactly the scene carrying it
    let mut tl4 = tl;
    tl4["tracks"][3]["clips"][1]["text"] = json!("Changed");
    let s4 = run_to_end(&params(&dir, tl4, "libx264", None)).await;
    assert_eq!(s4["result"]["scenesRendered"], 1, "{s4}");
}

#[tokio::test]
async fn real_ffmpeg_encoder_fallback_after_retry() {
    if !real_ffmpeg() {
        eprintln!("SKIP: no ffmpeg/ffprobe on PATH");
        return;
    }
    let dir = tmpdir("fallback");
    gen(&dir);
    let mut p = params(&dir, timeline(&dir, false), "h264_nvenc", None);
    p["fallbackEncoders"] = json!(["libx264"]);
    let s = run_to_end(&p).await;
    // With a working NVENC this renders directly; otherwise it must retry once and fall back.
    assert_eq!(s["status"], "done", "{s}");
    let attempts = s["result"]["attempts"].as_array().unwrap();
    if s["result"]["encoder"] == "libx264" {
        assert_eq!(attempts.len(), 2, "same encoder retried once: {attempts:?}");
        assert!(attempts.iter().all(|a| a["encoder"] == "h264_nvenc"));
    }
    assert!(dir.join("out/final.mp4").is_file());
}

#[tokio::test]
async fn missing_asset_fails_without_retry() {
    if !real_ffmpeg() {
        return;
    }
    let dir = tmpdir("missing");
    let s = run_to_end(&params(&dir, timeline(&dir, false), "libx264", None)).await;
    assert_eq!(s["status"], "failed");
    assert_eq!(s["error"]["code"], ERR_MISSING_ASSETS);
}

#[tokio::test]
async fn start_validates_params() {
    let e = start(&json!({})).await.unwrap_err();
    assert_eq!(e.code, crate::rpc::ERR_INVALID_PARAMS);
    let e = start(&json!({"timeline":{"tracks":[]},"cacheDir":"c","outputPath":"o","output":{"width":3,"height":2,"fps":25}})).await.unwrap_err();
    assert_eq!(e.code, crate::rpc::ERR_INVALID_PARAMS);
    assert_eq!(status(&json!({"jobId":"nope"})).unwrap_err().code, ERR_UNKNOWN_JOB);
}

// ---- fake ffmpeg that records its arguments (unix shell script)

#[cfg(unix)]
fn write_exec(p: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(p, body).unwrap();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
fn fake_dir(name: &str) -> PathBuf {
    let d = tmpdir(name);
    let script = format!(
        r#"#!/bin/sh
case "$*" in
  *-filters*) echo " T.. subtitles          V->V       Render text subtitles"; exit 0;;
esac
echo "$@" >> "{d}/calls.log"
if [ -f "{d}/sleep" ]; then exec sleep 30; fi
case "$*" in
  *"-c:v h264_nvenc"*) echo "Cannot load libcuda.so.1" >&2; exit 1;;
esac
for last; do :; done
echo "out_time_us=500000"
echo "fake" > "$last"
exit 0
"#,
        d = d.display()
    );
    write_exec(&d.join("ffmpeg"), &script);
    write_exec(&d.join("ffprobe"), "#!/bin/sh\necho 0\n");
    d
}

#[cfg(unix)]
fn fake_tl(dir: &Path) -> Value {
    for n in ["a.mp4", "b.mp4", "n.wav", "m.wav"] {
        std::fs::write(dir.join(n), n).unwrap();
    }
    timeline(dir, true)
}

#[cfg(unix)]
fn count_suffix(d: &Path, suffix: &str) -> usize {
    std::fs::read_dir(d).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(suffix)).count()
}

#[cfg(unix)]
#[tokio::test]
async fn fake_ffmpeg_records_expected_calls_and_renames_atomically() {
    let fd = fake_dir("fake1");
    let work = tmpdir("fake1-work");
    let tl = fake_tl(&work);
    let s = run_to_end(&params(&work, tl, "libx264", Some(&fd))).await;
    assert_eq!(s["status"], "done", "{s}");
    let log = std::fs::read_to_string(fd.join("calls.log")).unwrap();
    let calls: Vec<&str> = log.lines().collect();
    assert_eq!(calls.len(), 4, "3 scenes + final: {log}");
    assert!(calls[0].contains("-c:v libx264") && calls[0].contains("subtitles=filename=subs0.ass"));
    assert!(calls[3].contains("-f concat") && calls[3].contains("-c:v copy") && calls[3].contains("loudnorm"));
    assert!(calls[3].contains("volume='(1-(1-0.250)*clip("), "ducking under narration: {}", calls[3]);
    assert_eq!(count_suffix(&work.join("cache"), ".mp4"), 3);
    assert_eq!(count_suffix(&work.join("cache"), ".tmp"), 0);
    assert_eq!(std::fs::read_to_string(work.join("out/final.mp4")).unwrap().trim(), "fake");
}

#[cfg(unix)]
#[tokio::test]
async fn fake_ffmpeg_retry_then_fallback() {
    let fd = fake_dir("fake2");
    let work = tmpdir("fake2-work");
    let tl = fake_tl(&work);
    let mut p = params(&work, tl, "h264_nvenc", Some(&fd));
    p["fallbackEncoders"] = json!(["h264_mf"]);
    let s = run_to_end(&p).await;
    assert_eq!(s["status"], "done", "{s}");
    assert_eq!(s["result"]["encoder"], "h264_mf");
    assert_eq!(s["result"]["attempts"].as_array().unwrap().len(), 2);
    let log = std::fs::read_to_string(fd.join("calls.log")).unwrap();
    assert_eq!(log.matches("-c:v h264_nvenc").count(), 2, "retried once with the same encoder");
    assert!(log.matches("-c:v h264_mf").count() >= 3, "full re-render with the fallback");
    assert_eq!(s["result"]["scenesRendered"], 3);
}

#[cfg(unix)]
#[tokio::test]
async fn fake_ffmpeg_all_encoders_fail_ends_libx264_last() {
    let fd = fake_dir("fake3");
    let work = tmpdir("fake3-work");
    let tl = fake_tl(&work);
    write_exec(
        &fd.join("ffmpeg"),
        "#!/bin/sh\ncase \"$*\" in *-filters*) echo ' T.. subtitles V->V x'; exit 0;; esac\necho \"$@\" >> \"$(dirname \"$0\")/calls.log\"\necho boom >&2\nexit 1\n",
    );
    let mut p = params(&work, tl, "h264_nvenc", Some(&fd));
    p["fallbackEncoders"] = json!(["h264_qsv"]);
    let s = run_to_end(&p).await;
    assert_eq!(s["status"], "failed");
    assert_eq!(s["error"]["code"], ERR_RENDER_FAILED);
    let log = std::fs::read_to_string(fd.join("calls.log")).unwrap();
    let order: Vec<&str> = log.lines().map(|l| l.split("-c:v ").nth(1).unwrap().split(' ').next().unwrap()).collect();
    assert_eq!(order, vec!["h264_nvenc", "h264_nvenc", "h264_qsv", "h264_qsv", "libx264", "libx264"]);
}

#[cfg(unix)]
#[tokio::test]
async fn fake_ffmpeg_cancel_kills_child() {
    let fd = fake_dir("fake4");
    std::fs::write(fd.join("sleep"), "").unwrap();
    let work = tmpdir("fake4-work");
    let tl = fake_tl(&work);
    let id = start(&params(&work, tl, "libx264", Some(&fd))).await.unwrap()["jobId"].as_str().unwrap().to_string();
    let t = Instant::now();
    while !fd.join("calls.log").exists() {
        assert!(t.elapsed() < Duration::from_secs(10));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let c = cancel(&json!({ "jobId": id })).unwrap();
    assert_eq!(c["cancelRequested"], true);
    let t = Instant::now();
    let s = wait_final(&id).await;
    assert!(t.elapsed() < Duration::from_secs(5), "cancel must be prompt");
    assert_eq!(s["status"], "cancelled");
    assert_eq!(count_suffix(&work.join("cache"), ".tmp"), 0);
    assert!(!work.join("out/final.mp4").exists());
    assert_eq!(cancel(&json!({ "jobId": id })).unwrap()["cancelRequested"], false);
}
