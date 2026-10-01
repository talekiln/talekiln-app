//! media.probe: run ffprobe and normalise its JSON.

use crate::ffmpeg::{self, FfError};
use serde_json::{json, Value};
use std::path::Path;

fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|x| x.is_finite())
}

fn int(v: Option<&Value>) -> Option<i64> {
    num(v).map(|x| x as i64)
}

/// "30000/1001" or "25" -> fps. 0/0 and non-positive yield None.
pub fn parse_rate(s: &str) -> Option<f64> {
    let s = s.trim();
    let r = match s.split_once('/') {
        Some((n, d)) => {
            let (n, d) = (n.trim().parse::<f64>().ok()?, d.trim().parse::<f64>().ok()?);
            if d == 0.0 {
                return None;
            }
            n / d
        }
        None => s.parse::<f64>().ok()?,
    };
    if r.is_finite() && r > 0.0 {
        Some((r * 1000.0).round() / 1000.0)
    } else {
        None
    }
}

/// Parse `ffprobe -print_format json -show_format -show_streams` output.
pub fn parse_probe(text: &str) -> Result<Value, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("ffprobe output is not valid JSON: {e}"))?;
    let streams_in: &[Value] = root.get("streams").and_then(|s| s.as_array()).map(|v| v.as_slice()).unwrap_or(&[]);
    let format = root.get("format");
    if streams_in.is_empty() && format.is_none() {
        return Err("ffprobe output has neither streams nor format".into());
    }
    let mut streams = Vec::new();
    for (i, s) in streams_in.iter().enumerate() {
        let kind = s.get("codec_type").and_then(|v| v.as_str()).unwrap_or("unknown");
        let fps = ["avg_frame_rate", "r_frame_rate"]
            .iter()
            .filter_map(|k| s.get(*k).and_then(|v| v.as_str()).and_then(parse_rate))
            .next();
        let attached_pic = s.pointer("/disposition/attached_pic").and_then(|v| v.as_i64()) == Some(1);
        let mut o = json!({
            "index": int(s.get("index")).unwrap_or(i as i64),
            "type": kind,
            "codec": s.get("codec_name").and_then(|v| v.as_str()),
            "durationSec": num(s.get("duration")),
            "bitRate": int(s.get("bit_rate")),
        });
        if kind == "video" {
            o["width"] = json!(int(s.get("width")));
            o["height"] = json!(int(s.get("height")));
            o["fps"] = json!(fps);
            o["pixFmt"] = json!(s.get("pix_fmt").and_then(|v| v.as_str()));
            o["attachedPic"] = json!(attached_pic);
        } else if kind == "audio" {
            o["sampleRate"] = json!(int(s.get("sample_rate")));
            o["channels"] = json!(int(s.get("channels")));
        }
        streams.push(o);
    }
    let first = |t: &str| streams.iter().find(|s| s["type"] == t && s["attachedPic"] != true).cloned();
    let video = first("video");
    let audio = first("audio");
    // Container duration, else the longest stream duration.
    let duration = num(format.and_then(|f| f.get("duration"))).or_else(|| {
        streams
            .iter()
            .filter_map(|s| s["durationSec"].as_f64())
            .fold(None, |a: Option<f64>, d| Some(a.map_or(d, |x| x.max(d))))
    });
    Ok(json!({
        "durationSec": duration,
        "formatName": format.and_then(|f| f.get("format_name")).and_then(|v| v.as_str()),
        "sizeBytes": int(format.and_then(|f| f.get("size"))),
        "bitRate": int(format.and_then(|f| f.get("bit_rate"))),
        "hasVideo": video.is_some(),
        "hasAudio": audio.is_some(),
        "video": video,
        "audio": audio,
        "streams": streams,
    }))
}

pub async fn probe(params: &Value) -> Result<Value, FfError> {
    let path = params.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let Some(path) = path else {
        return Err(FfError {
            code: crate::rpc::ERR_INVALID_PARAMS,
            message: "params.path must be a non-empty string".into(),
            data: None,
        });
    };
    let exe = ffmpeg::locate("ffprobe", params.get("ffmpegDir").and_then(|v| v.as_str()))?;
    let timeout = params.get("timeoutSec").and_then(|v| v.as_u64()).unwrap_or(30).clamp(1, 600);
    let args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i"]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(path.to_string()))
        .collect();
    let out = ffmpeg::run(&exe, "ffprobe", &args, timeout).await?;
    if !out.status_ok {
        let why = ffmpeg::tail(&out.stderr, 300);
        let msg = if Path::new(path).exists() {
            format!("ffprobe could not read media: {why}")
        } else {
            format!("media file not found: {path}")
        };
        return Err(FfError::failed(msg, &out.stderr, out.code));
    }
    let mut v = parse_probe(&out.stdout).map_err(FfError::output)?;
    v["path"] = Value::from(path);
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_av_fixture() {
        let v = parse_probe(include_str!("fixtures/ffprobe_av.json")).unwrap();
        assert_eq!(v["durationSec"], 63.52);
        assert_eq!(v["formatName"], "mov,mp4,m4a,fnp,3gp,3g2,mj2");
        assert_eq!(v["video"]["codec"], "h264");
        assert_eq!(v["video"]["width"], 1920);
        assert_eq!(v["video"]["height"], 1080);
        assert_eq!(v["video"]["fps"], 29.97);
        assert_eq!(v["audio"]["codec"], "aac");
        assert_eq!(v["audio"]["sampleRate"], 48000);
        assert_eq!(v["audio"]["channels"], 2);
        assert_eq!(v["streams"].as_array().unwrap().len(), 3);
        assert_eq!(v["sizeBytes"], 18734021);
    }

    #[test]
    fn cover_art_is_not_the_video_stream() {
        let v = parse_probe(include_str!("fixtures/ffprobe_audio_cover.json")).unwrap();
        assert_eq!(v["hasVideo"], false);
        assert_eq!(v["hasAudio"], true);
        assert_eq!(v["audio"]["sampleRate"], 44100);
        assert_eq!(v["durationSec"], 215.04);
    }

    #[test]
    fn defensive_on_sparse_output() {
        let v = parse_probe(r#"{"streams":[{"codec_type":"video","avg_frame_rate":"0/0","r_frame_rate":"25/1","width":"640"}]}"#).unwrap();
        assert_eq!(v["video"]["fps"], 25.0);
        assert_eq!(v["video"]["width"], 640);
        assert!(v["video"]["height"].is_null());
        assert!(v["durationSec"].is_null());
        assert!(parse_probe("not json").is_err());
        assert!(parse_probe("{}").is_err());
    }

    #[test]
    fn rates() {
        assert_eq!(parse_rate("30000/1001"), Some(29.97));
        assert_eq!(parse_rate("0/0"), None);
        assert_eq!(parse_rate("24"), Some(24.0));
        assert_eq!(parse_rate("abc"), None);
    }
}
