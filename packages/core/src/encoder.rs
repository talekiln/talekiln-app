//! encoder.detect: list H.264 encoder candidates and test-encode with each.

use crate::ffmpeg::{self, FfError};
use serde_json::{json, Value};
use std::collections::HashSet;

/// Candidate order = preference order (hardware first, software fallbacks last).
/// libopenh264 is what the pinned LGPL ffmpeg build ships instead of libx264 (scripts/ffmpeg-pin.json).
pub const CANDIDATES: &[(&str, &str)] = &[
    ("h264_nvenc", "nvidia"),
    ("h264_qsv", "intel"),
    ("h264_amf", "amd"),
    ("h264_mf", "mediafoundation"),
    ("h264_videotoolbox", "apple"),
    ("libx264", "software"),
    ("libopenh264", "software"),
];

/// Software (CPU) encoders, in preference order; always tried after every hardware encoder.
pub fn is_software(name: &str) -> bool {
    CANDIDATES.iter().any(|(n, v)| *n == name && *v == "software")
}

/// Names of encoders listed by `ffmpeg -hide_banner -encoders`. Skips the legend/header.
pub fn parse_encoders(text: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    let mut in_list = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("------") {
            in_list = true;
            continue;
        }
        if !in_list {
            continue;
        }
        let mut it = t.split_whitespace();
        let (Some(flags), Some(name)) = (it.next(), it.next()) else { continue };
        // flags look like "V....D": 6 chars, first is the media type.
        if flags.len() == 6 && flags.chars().all(|c| c.is_ascii_alphabetic() || c == '.') {
            set.insert(name.to_string());
        }
    }
    set
}

/// Strip a leading "[name @ 0x...] " log prefix.
fn strip_prefix(l: &str) -> &str {
    let l = l.trim();
    if l.starts_with('[') {
        if let Some(i) = l.find("] ") {
            return l[i + 2..].trim();
        }
    }
    l
}

/// Pick the most informative line of a failed test-encode's stderr.
pub fn failure_reason(stderr: &str) -> String {
    const GENERIC: &[&str] = &[
        "Error initializing output stream",
        "Error while opening encoder",
        "Conversion failed",
        "Error opening output",
        "Could not open encoder",
    ];
    let lines: Vec<&str> = stderr.lines().map(strip_prefix).filter(|l| !l.is_empty()).collect();
    let pick = lines
        .iter()
        .find(|l| !GENERIC.iter().any(|g| l.starts_with(g)) && !l.starts_with("Last message repeated"))
        .or_else(|| lines.first());
    match pick {
        Some(l) => ffmpeg::tail(l, 200),
        None => "test encode failed (no diagnostic output)".to_string(),
    }
}

/// Build the ordered result. `tests` maps encoder -> Ok(()) | Err(reason) for those that were tested.
pub fn build_result(listed: &HashSet<String>, tests: &[(String, Result<(), String>)]) -> Value {
    let mut items = Vec::new();
    let mut recommended = Vec::new();
    for (name, vendor) in CANDIDATES {
        let (available, reason) = if !listed.contains(*name) {
            (false, "not compiled into this ffmpeg build".to_string())
        } else {
            match tests.iter().find(|(n, _)| n == name) {
                Some((_, Ok(()))) => (true, "test encode succeeded".to_string()),
                Some((_, Err(r))) => (false, r.clone()),
                None => (false, "not tested".to_string()),
            }
        };
        if available {
            recommended.push(*name);
        }
        items.push(json!({
            "name": name, "vendor": vendor, "hardware": *vendor != "software",
            "listed": listed.contains(*name), "available": available, "reason": reason,
        }));
    }
    json!({ "encoders": items, "recommended": recommended, "best": recommended.first() })
}

pub async fn detect(params: &Value) -> Result<Value, FfError> {
    let exe = ffmpeg::locate("ffmpeg", params.get("ffmpegDir").and_then(|v| v.as_str()))?;
    let timeout = params.get("timeoutSec").and_then(|v| v.as_u64()).unwrap_or(15).clamp(1, 120);
    let list_args: Vec<String> = ["-hide_banner", "-encoders"].iter().map(|s| s.to_string()).collect();
    let out = ffmpeg::run(&exe, "ffmpeg", &list_args, timeout).await?;
    if !out.status_ok {
        return Err(FfError::failed("ffmpeg -encoders failed".into(), &out.stderr, out.code));
    }
    let listed = parse_encoders(&out.stdout);
    if listed.is_empty() {
        return Err(FfError::output("could not parse `ffmpeg -encoders` output".into()));
    }
    let mut tests = Vec::new();
    // Sequential on purpose: avoid hammering GPU drivers with parallel sessions.
    for (name, _) in CANDIDATES {
        if !listed.contains(*name) {
            continue;
        }
        let args: Vec<String> = [
            "-hide_banner", "-v", "error", "-nostdin", "-f", "lavfi", "-i",
            "testsrc=duration=1:size=640x360:rate=30", "-frames:v", "30", "-pix_fmt", "yuv420p",
            "-c:v", name, "-f", "null", "-",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let r = match ffmpeg::run(&exe, "ffmpeg", &args, timeout).await {
            Ok(o) if o.status_ok => Ok(()),
            Ok(o) => Err(failure_reason(&o.stderr)),
            Err(e) if e.code == ffmpeg::ERR_FFMPEG_TIMEOUT => Err(format!("test encode timed out after {timeout}s")),
            Err(e) => return Err(e),
        };
        tests.push((name.to_string(), r));
    }
    Ok(build_result(&listed, &tests))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_encoder_list() {
        let s = parse_encoders(include_str!("fixtures/ffmpeg_encoders.txt"));
        for n in ["libx264", "h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "aac", "mov_text"] {
            assert!(s.contains(n), "{n}");
        }
        // legend lines are not encoders
        assert!(!s.contains("="));
        assert!(!s.contains("Video"));
        let m = parse_encoders(include_str!("fixtures/ffmpeg_encoders_minimal.txt"));
        assert!(m.contains("libx264") && !m.contains("h264_nvenc"));
        assert!(parse_encoders("garbage\nno list").is_empty());
    }

    #[test]
    fn reason_extraction() {
        let nv = "[h264_nvenc @ 0x55d0c8a1b2c0] Cannot load libcuda.so.1\n[h264_nvenc @ 0x55d0c8a1b2c0] Err: -1\nError initializing output stream 0:0 -- Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height\nConversion failed!\n";
        assert_eq!(failure_reason(nv), "Cannot load libcuda.so.1");
        let qsv = "[h264_qsv @ 0x1] Error initializing an internal MFX session: unsupported (-3)\nError initializing output stream 0:0 -- Error while opening encoder\n";
        assert!(failure_reason(qsv).starts_with("Error initializing an internal MFX"));
        assert_eq!(failure_reason(""), "test encode failed (no diagnostic output)");
        assert_eq!(failure_reason("Conversion failed!\n"), "Conversion failed!");
    }

    #[test]
    fn recommended_order() {
        let listed = parse_encoders(include_str!("fixtures/ffmpeg_encoders.txt"));
        let tests = vec![
            ("h264_nvenc".to_string(), Err("Cannot load libcuda.so.1".to_string())),
            ("h264_qsv".to_string(), Ok(())),
            ("h264_amf".to_string(), Err("amf unsupported".to_string())),
            ("h264_mf".to_string(), Ok(())),
            ("h264_videotoolbox".to_string(), Ok(())),
            ("libx264".to_string(), Ok(())),
        ];
        let r = build_result(&listed, &tests);
        assert_eq!(r["recommended"], json!(["h264_qsv", "h264_mf", "libx264"]));
        assert_eq!(r["best"], "h264_qsv");
        let enc = r["encoders"].as_array().unwrap();
        assert_eq!(enc.len(), 6);
        assert_eq!(enc[0]["name"], "h264_nvenc");
        assert_eq!(enc[0]["available"], false);
        assert_eq!(enc[0]["reason"], "Cannot load libcuda.so.1");
    }

    #[test]
    fn videotoolbox_preferred_on_mac_lgpl_build() {
        // An LGPL macOS build has no libx264; VideoToolbox is then the only H.264 encoder.
        let listed = parse_encoders(include_str!("fixtures/ffmpeg_encoders_macos_lgpl.txt"));
        assert!(listed.contains("h264_videotoolbox") && !listed.contains("libx264"));
        let r = build_result(&listed, &[("h264_videotoolbox".to_string(), Ok(()))]);
        assert_eq!(r["recommended"], json!(["h264_videotoolbox"]));
        assert_eq!(r["best"], "h264_videotoolbox");
        let vt = r["encoders"].as_array().unwrap().iter().find(|e| e["name"] == "h264_videotoolbox").unwrap();
        assert_eq!(vt["vendor"], "apple");
        assert_eq!(vt["hardware"], true);
    }

    #[test]
    fn openh264_is_the_software_fallback_when_libx264_is_absent() {
        // The pinned LGPL ffmpeg build (scripts/ffmpeg-pin.json) ships libopenh264 and no libx264.
        let listed = parse_encoders(include_str!("fixtures/ffmpeg_encoders_openh264.txt"));
        assert!(listed.contains("libopenh264") && !listed.contains("libx264"));
        let r = build_result(&listed, &[("libopenh264".to_string(), Ok(()))]);
        assert_eq!(r["recommended"], json!(["libopenh264"]));
        assert_eq!(r["best"], "libopenh264");
        let enc = r["encoders"].as_array().unwrap();
        let oh = enc.iter().find(|e| e["name"] == "libopenh264").expect("libopenh264 is a candidate");
        assert_eq!(oh["hardware"], false);
        assert_eq!(oh["vendor"], "software");
        assert_eq!(enc.last().unwrap()["name"], "libopenh264", "software encoders come last");
        // with both present, libx264 is still preferred over libopenh264
        let both: HashSet<String> = ["libx264", "libopenh264"].iter().map(|s| s.to_string()).collect();
        let r = build_result(&both, &[("libopenh264".to_string(), Ok(())), ("libx264".to_string(), Ok(()))]);
        assert_eq!(r["recommended"], json!(["libx264", "libopenh264"]));
    }

    #[test]
    fn unlisted_encoders_unavailable() {
        let listed = parse_encoders(include_str!("fixtures/ffmpeg_encoders_minimal.txt"));
        let r = build_result(&listed, &[("libx264".to_string(), Ok(()))]);
        assert_eq!(r["recommended"], json!(["libx264"]));
        assert_eq!(r["encoders"][0]["reason"], "not compiled into this ffmpeg build");
        let none = build_result(&listed, &[("libx264".to_string(), Err("boom".into()))]);
        assert_eq!(none["recommended"], json!([]));
        assert!(none["best"].is_null());
    }
}
