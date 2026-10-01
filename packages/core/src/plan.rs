//! render.plan: split a timeline into scenes, compute deterministic scene keys, check the cache.
//! Canonical JSON rules are documented in README.md.

use crate::sha256;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

/// Bump whenever rendering output could change for identical input; invalidates every cached scene.
pub const RENDERER_VERSION: &str = "r1";

fn i64_of(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_i64())
}

/// Volume to integer 1/10000 units (avoids float formatting differences).
fn vol_units(v: Option<&Value>) -> i64 {
    (v.and_then(|x| x.as_f64()).unwrap_or(1.0) * 10000.0).round() as i64
}

/// Recursively sort object keys (serde_json's default Map is already ordered; this is explicit).
pub fn canonicalize(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut o = Map::new();
            for k in keys {
                o.insert(k.clone(), canonicalize(&m[k]));
            }
            Value::Object(o)
        }
        Value::Array(a) => Value::Array(a.iter().map(canonicalize).collect()),
        o => o.clone(),
    }
}

pub fn canonical_string(v: &Value) -> String {
    serde_json::to_string(&canonicalize(v)).unwrap()
}

fn hash_file(p: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = sha256::Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finish_hex())
}

/// Identity of a source file; the bool is false when the file is missing.
fn file_identity(asset: &str, hash_content: bool) -> (Value, bool) {
    let p = Path::new(asset);
    match std::fs::metadata(p) {
        Ok(md) => {
            if hash_content {
                if let Ok(h) = hash_file(p) {
                    return (json!({ "sha256": h }), true);
                }
            }
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            (json!({ "path": asset, "size": md.len(), "mtimeMs": mtime }), true)
        }
        Err(_) => (json!({ "path": asset, "missing": true }), false),
    }
}

struct Clip<'a> {
    raw: &'a Value,
    start: i64,
    dur: i64,
}

fn track<'a>(tl: &'a Value, kind: &str) -> Option<&'a Value> {
    tl.get("tracks")?.as_array()?.iter().find(|t| t.get("kind").and_then(|k| k.as_str()) == Some(kind))
}

fn clips<'a>(t: Option<&'a Value>, kind: &str) -> Result<Vec<Clip<'a>>, String> {
    let mut out = vec![];
    if let Some(arr) = t.and_then(|t| t.get("clips")).and_then(|c| c.as_array()) {
        for c in arr {
            let (Some(start), Some(dur)) = (i64_of(c, "start_ms"), i64_of(c, "duration_ms")) else {
                return Err(format!("{kind} clip needs integer start_ms and duration_ms"));
            };
            if start < 0 || dur <= 0 {
                return Err(format!("{kind} clip has invalid start_ms/duration_ms"));
            }
            out.push(Clip { raw: c, start, dur });
        }
    }
    // Stable order: start, then duration, then id (deterministic regardless of input order).
    let id = |c: &Clip| c.raw.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    out.sort_by(|a, b| (a.start, a.dur, id(a)).cmp(&(b.start, b.dur, id(b))));
    Ok(out)
}

fn track_gain(t: Option<&Value>) -> i64 {
    match t {
        Some(t) if t.get("muted").map(|m| m.as_bool().unwrap_or(m.as_i64().unwrap_or(0) != 0)).unwrap_or(false) => 0,
        Some(t) => vol_units(t.get("volume")),
        None => 10000,
    }
}

fn style_value(s: Option<&Value>) -> Value {
    match s {
        Some(Value::String(t)) => serde_json::from_str(t).unwrap_or(Value::String(t.clone())),
        Some(v) => v.clone(),
        None => Value::Null,
    }
}

struct Seg<'a> {
    start: i64,
    end: i64,
    v: Option<(&'a Clip<'a>, i64)>,
}

pub fn plan(params: &Value) -> Result<Value, String> {
    let tl = params.get("timeline").ok_or("params.timeline is required")?;
    if !tl.get("tracks").map(|t| t.is_array()).unwrap_or(false) {
        return Err("params.timeline.tracks must be an array".into());
    }
    let cache = params.get("cacheDir").and_then(|c| c.as_str()).ok_or("params.cacheDir is required")?;
    let o = params.get("output").or_else(|| tl.get("output")).ok_or("params.output is required")?;
    let (Some(w), Some(h), Some(fps)) = (i64_of(o, "width"), i64_of(o, "height"), o.get("fps").and_then(|f| f.as_f64()))
    else {
        return Err("output needs width, height, fps".into());
    };
    if w <= 0 || h <= 0 || fps <= 0.0 {
        return Err("output width/height/fps must be positive".into());
    }
    let encoder = o.get("encoder").and_then(|e| e.as_str()).unwrap_or("libx264");
    // fps as integer milli-fps keeps the key float-free.
    let out_key = json!({ "width": w, "height": h, "fpsMilli": (fps * 1000.0).round() as i64, "encoder": encoder });
    let hash_content = params.get("hashContent").and_then(|b| b.as_bool()).unwrap_or(false);

    let (vt, st, nt, mt) = (track(tl, "video"), track(tl, "subtitle"), track(tl, "narration"), track(tl, "music"));
    let video = clips(vt, "video")?;
    let subs = clips(st, "subtitle")?;
    let narr = clips(nt, "narration")?;
    let music = clips(mt, "music")?;
    let vgain = track_gain(vt);
    let ngain = track_gain(nt);

    let total = video.iter().chain(&subs).chain(&narr).chain(&music).map(|c| c.start + c.dur).max().unwrap_or(0);

    let mut segs: Vec<Seg> = vec![];
    let mut cur = 0i64;
    for c in &video {
        let start = c.start.max(cur); // overlapping video clips are clamped to the previous end
        let end = c.start + c.dur;
        if end <= start {
            continue;
        }
        if start > cur {
            segs.push(Seg { start: cur, end: start, v: None });
        }
        let src_in = c.raw.get("src_in_ms").and_then(|x| x.as_i64()).unwrap_or(0) + (start - c.start);
        segs.push(Seg { start, end, v: Some((c, src_in)) });
        cur = end;
    }
    if total > cur {
        segs.push(Seg { start: cur, end: total, v: None });
    }

    let mut missing: Vec<String> = vec![];
    let mut note_missing = |asset: &str, ok: bool| {
        if !ok && !missing.iter().any(|m| m == asset) {
            missing.push(asset.to_string());
        }
    };
    let mut scenes = vec![];
    let mut to_render = vec![];
    let mut seen_keys: HashSet<String> = HashSet::new();
    for (i, s) in segs.iter().enumerate() {
        let dur = s.end - s.start;
        let (vkey, kind, clip_id) = match s.v {
            Some((c, src_in)) => {
                let asset = c.raw.get("asset_ref").and_then(|a| a.as_str()).unwrap_or("");
                let (ident, ok) = file_identity(asset, hash_content);
                note_missing(asset, ok);
                (
                    json!({
                        "src": ident, "assetKind": c.raw.get("asset_kind").cloned().unwrap_or(Value::Null),
                        "srcInMs": src_in, "srcOutMs": src_in + dur,
                        "gain": vol_units(c.raw.get("volume")) * vgain / 10000,
                    }),
                    "video",
                    c.raw.get("id").cloned().unwrap_or(Value::Null),
                )
            }
            None => (Value::Null, "gap", Value::Null),
        };
        // Overlaps are described in scene-relative time so moving a scene does not change its key.
        let overlap = |c: &Clip| -> Option<(i64, i64)> {
            let a = c.start.max(s.start);
            let b = (c.start + c.dur).min(s.end);
            if b > a {
                Some((a, b))
            } else {
                None
            }
        };
        let sub_v: Vec<Value> = subs
            .iter()
            .filter_map(|c| {
                let (a, b) = overlap(c)?;
                Some(json!({
                    "relStartMs": a - s.start, "relEndMs": b - s.start,
                    "text": c.raw.get("text").cloned().unwrap_or(Value::Null),
                    "style": style_value(c.raw.get("style")),
                }))
            })
            .collect();
        let mut narr_v: Vec<Value> = vec![];
        let mut narr_d: Vec<Value> = vec![];
        for c in &narr {
            let Some((a, b)) = overlap(c) else { continue };
            let asset = c.raw.get("asset_ref").and_then(|x| x.as_str()).unwrap_or("");
            let (ident, ok) = file_identity(asset, hash_content);
            note_missing(asset, ok);
            let src_in = c.raw.get("src_in_ms").and_then(|x| x.as_i64()).unwrap_or(0) + (a - c.start);
            let gain = vol_units(c.raw.get("volume")) * ngain / 10000;
            narr_d.push(json!({
                "relStartMs": a - s.start, "durMs": b - a, "assetRef": asset, "srcInMs": src_in, "gain": gain,
            }));
            narr_v.push(json!({
                "relStartMs": a - s.start, "durMs": b - a, "src": ident,
                "srcInMs": src_in, "gain": gain,
            }));
        }
        // Render inputs (real paths); NOT part of the key.
        let detail = json!({
            "video": s.v.map(|(c, src_in)| json!({
                "assetRef": c.raw.get("asset_ref").cloned().unwrap_or(Value::Null),
                "assetKind": c.raw.get("asset_kind").cloned().unwrap_or(Value::Null),
                "srcInMs": src_in, "srcOutMs": src_in + dur, "gain": vkey["gain"],
            })).unwrap_or(Value::Null),
            "subtitles": sub_v, "narration": narr_d,
        });
        let payload = json!({
            "rendererVersion": RENDERER_VERSION, "kind": kind, "durMs": dur, "output": out_key,
            "video": vkey, "subtitles": sub_v, "narration": narr_v,
        });
        let key = sha256::hex(canonical_string(&payload).as_bytes());
        let cache_path = Path::new(cache).join(format!("{key}.mp4"));
        let hit = cache_path.is_file();
        if !hit && seen_keys.insert(key.clone()) {
            to_render.push(i);
        }
        scenes.push(json!({
            "index": i, "kind": kind, "clipId": clip_id, "startMs": s.start, "durationMs": dur,
            "sceneKey": key, "cacheHit": hit, "cachePath": cache_path.to_string_lossy(),
            "detail": detail,
        }));
    }

    let music_v: Vec<Value> = music
        .iter()
        .map(|c| {
            json!({
                "clipId": c.raw.get("id").cloned().unwrap_or(Value::Null), "startMs": c.start, "durationMs": c.dur,
                "assetRef": c.raw.get("asset_ref").cloned().unwrap_or(Value::Null),
                "srcInMs": c.raw.get("src_in_ms").and_then(|x| x.as_i64()).unwrap_or(0),
                "gain": vol_units(c.raw.get("volume")) * track_gain(mt) / 10000,
            })
        })
        .collect();
    Ok(json!({
        "rendererVersion": RENDERER_VERSION, "durationMs": total, "scenes": scenes,
        "toRender": to_render, "music": music_v, "missingAssets": missing,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(dir: &Path) -> (Value, Value) {
        for n in ["a.mp4", "b.mp4", "n.wav", "m.mp3"] {
            std::fs::write(dir.join(n), n.as_bytes()).unwrap();
        }
        let p = |n: &str| dir.join(n).to_string_lossy().to_string();
        let tl = json!({ "tracks": [
            { "kind": "video", "volume": 1, "muted": false, "clips": [
                { "id": "v1", "start_ms": 0, "duration_ms": 4000, "src_in_ms": 1000, "src_out_ms": 5000, "asset_ref": p("a.mp4"), "asset_kind": "video", "volume": 1 },
                { "id": "v2", "start_ms": 5000, "duration_ms": 3000, "src_in_ms": 0, "src_out_ms": 3000, "asset_ref": p("b.mp4"), "asset_kind": "video", "volume": 1 } ]},
            { "kind": "subtitle", "clips": [
                { "id": "s1", "start_ms": 500, "duration_ms": 1000, "text": "hello", "style": "{\"size\":40}" },
                { "id": "s2", "start_ms": 5500, "duration_ms": 1000, "text": "world", "style": {"size": 40} } ]},
            { "kind": "narration", "volume": 1, "clips": [
                { "id": "n1", "start_ms": 5000, "duration_ms": 2000, "asset_ref": p("n.wav"), "volume": 1 } ]},
            { "kind": "music", "volume": 0.5, "clips": [
                { "id": "m1", "start_ms": 0, "duration_ms": 8000, "asset_ref": p("m.mp3"), "volume": 1 } ]}
        ]});
        let out = json!({ "width": 1920, "height": 1080, "fps": 30, "encoder": "libx264" });
        (tl, out)
    }

    fn run(tl: &Value, out: &Value, cache: &Path) -> Value {
        plan(&json!({ "timeline": tl, "output": out, "cacheDir": cache.to_string_lossy() })).unwrap()
    }

    fn keys(r: &Value) -> Vec<String> {
        r["scenes"].as_array().unwrap().iter().map(|s| s["sceneKey"].as_str().unwrap().to_string()).collect()
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("lycore-plan-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn changed(a: &[String], b: &[String]) -> Vec<usize> {
        assert_eq!(a.len(), b.len());
        (0..a.len()).filter(|&i| a[i] != b[i]).collect()
    }

    #[test]
    fn scenes_and_gaps() {
        let d = tmp("gaps");
        let (tl, out) = fixture(&d);
        let r = run(&tl, &out, &d.join("cache"));
        assert_eq!(r["durationMs"], 8000);
        let k: Vec<_> = r["scenes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s["kind"].as_str().unwrap(), s["startMs"].as_i64().unwrap(), s["durationMs"].as_i64().unwrap()))
            .collect();
        assert_eq!(k, vec![("video", 0, 4000), ("gap", 4000, 1000), ("video", 5000, 3000)]);
        assert_eq!(r["toRender"], json!([0, 1, 2]));
        assert_eq!(r["music"].as_array().unwrap().len(), 1);
        assert_eq!(r["music"][0]["gain"], 5000);
    }

    #[test]
    fn deterministic_and_order_independent() {
        let d = tmp("det");
        let (mut tl, out) = fixture(&d);
        let a = keys(&run(&tl, &out, &d));
        assert_eq!(a, keys(&run(&tl, &out, &d)));
        tl["tracks"][0]["clips"].as_array_mut().unwrap().reverse();
        assert_eq!(a, keys(&run(&tl, &out, &d)));
        // style as JSON string vs object is canonicalised
        tl["tracks"][1]["clips"][0]["style"] = json!({"size": 40});
        assert_eq!(a, keys(&run(&tl, &out, &d)));
    }

    #[test]
    fn single_edits_change_only_one_scene() {
        let d = tmp("edit");
        let (tl, out) = fixture(&d);
        let base = keys(&run(&tl, &out, &d));
        let mut t = tl.clone();
        t["tracks"][0]["clips"][0]["src_in_ms"] = json!(2000);
        t["tracks"][0]["clips"][0]["src_out_ms"] = json!(6000);
        assert_eq!(changed(&base, &keys(&run(&t, &out, &d))), vec![0]);
        // source file size change
        std::fs::write(d.join("b.mp4"), b"different size").unwrap();
        assert_eq!(changed(&base, &keys(&run(&tl, &out, &d))), vec![2]);
        std::fs::write(d.join("b.mp4"), b"b.mp4").unwrap();
        let base = keys(&run(&tl, &out, &d)); // mtime changed by the rewrite
        // source path change
        let mut t = tl.clone();
        t["tracks"][0]["clips"][0]["asset_ref"] = json!(d.join("b.mp4").to_string_lossy());
        assert_eq!(changed(&base, &keys(&run(&t, &out, &d))), vec![0]);
        let mut t = tl.clone();
        t["tracks"][1]["clips"][1]["text"] = json!("changed");
        assert_eq!(changed(&base, &keys(&run(&t, &out, &d))), vec![2]);
        let mut t = tl.clone();
        t["tracks"][1]["clips"][0]["style"] = json!({"size": 50});
        assert_eq!(changed(&base, &keys(&run(&t, &out, &d))), vec![0]);
        let mut t = tl.clone();
        t["tracks"][0]["clips"][1]["volume"] = json!(0.5);
        assert_eq!(changed(&base, &keys(&run(&t, &out, &d))), vec![2]);
        // narration volume touches only the scene it overlaps
        let mut t = tl.clone();
        t["tracks"][2]["clips"][0]["volume"] = json!(0.5);
        assert_eq!(changed(&base, &keys(&run(&t, &out, &d))), vec![2]);
        // output settings change everything
        let mut o = out.clone();
        o["width"] = json!(1280);
        assert_eq!(changed(&base, &keys(&run(&tl, &o, &d))), vec![0, 1, 2]);
    }

    #[test]
    fn music_and_moves_do_not_affect_scene_keys() {
        let d = tmp("music");
        let (tl, out) = fixture(&d);
        let base = keys(&run(&tl, &out, &d));
        let mut t = tl.clone();
        t["tracks"][3]["clips"][0]["volume"] = json!(2.0);
        t["tracks"][3]["volume"] = json!(0.1);
        assert_eq!(base, keys(&run(&t, &out, &d)));
        // keys are scene-relative: shifting the later shot and its subtitle/narration keeps the key
        let mut t = tl.clone();
        t["tracks"][0]["clips"][1]["start_ms"] = json!(6000);
        t["tracks"][1]["clips"][1]["start_ms"] = json!(6500);
        t["tracks"][2]["clips"][0]["start_ms"] = json!(6000);
        let k = keys(&run(&t, &out, &d));
        assert_eq!(k[0], base[0]);
        assert_eq!(k[2], base[2]);
        assert_ne!(k[1], base[1]); // the gap is longer
    }

    #[test]
    fn cache_hit_detection() {
        let d = tmp("cache");
        let (tl, out) = fixture(&d);
        let cache = d.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let k = keys(&run(&tl, &out, &cache));
        std::fs::write(cache.join(format!("{}.mp4", k[0])), b"x").unwrap();
        std::fs::write(cache.join(format!("{}.mp4", k[1])), b"x").unwrap();
        let r = run(&tl, &out, &cache);
        let hits: Vec<_> = r["scenes"].as_array().unwrap().iter().map(|s| s["cacheHit"].as_bool().unwrap()).collect();
        assert_eq!(hits, vec![true, true, false]);
        assert_eq!(r["toRender"], json!([2]));
    }

    #[test]
    fn edge_cases() {
        let d = tmp("edge");
        let out = json!({ "width": 640, "height": 360, "fps": 30 });
        let r = run(&json!({ "tracks": [] }), &out, &d);
        assert_eq!(r["durationMs"], 0);
        assert!(r["scenes"].as_array().unwrap().is_empty());
        // only subtitles: one gap scene carrying them
        let tl = json!({ "tracks": [{ "kind": "subtitle", "clips": [{ "start_ms": 1000, "duration_ms": 1000, "text": "x" }] }] });
        let r = run(&tl, &out, &d);
        assert_eq!(r["durationMs"], 2000);
        assert_eq!(r["scenes"][0]["kind"], "gap");
        // missing asset reported, plan still produced
        let tl = json!({ "tracks": [{ "kind": "video", "clips": [{ "start_ms": 0, "duration_ms": 1000, "asset_ref": "/nope/x.mp4" }] }] });
        let r = run(&tl, &out, &d);
        assert_eq!(r["missingAssets"], json!(["/nope/x.mp4"]));
        // overlapping video clips: the later one is clamped to start at the previous end
        let (tl, o2) = fixture(&d);
        let mut t = tl.clone();
        t["tracks"][0]["clips"][1]["start_ms"] = json!(3000);
        let r = run(&t, &o2, &d);
        assert_eq!(r["scenes"][1]["startMs"], 4000);
        assert_eq!(r["scenes"][1]["durationMs"], 2000);
        assert!(plan(&json!({})).is_err());
    }

    #[test]
    fn content_hash_mode_ignores_mtime() {
        let d = tmp("hash");
        let (tl, out) = fixture(&d);
        let run_h = |tl: &Value| {
            keys(&plan(&json!({ "timeline": tl, "output": out, "cacheDir": d.to_string_lossy(), "hashContent": true })).unwrap())
        };
        let a = run_h(&tl);
        std::fs::write(d.join("a.mp4"), b"a.mp4").unwrap(); // same content, new mtime
        assert_eq!(a, run_h(&tl));
        std::fs::write(d.join("a.mp4"), b"A.mp4").unwrap();
        assert_ne!(a[0], run_h(&tl)[0]);
    }
}
