//! Locating and running the bundled ffmpeg/ffprobe binaries (async, with timeouts).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

pub const ENV_DIR: &str = "LYCORE_FFMPEG_DIR";

/// Structured failure, convertible to a JSON-RPC error by rpc.rs.
#[derive(Debug)]
pub struct FfError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

pub const ERR_FFMPEG_MISSING: i64 = -32020;
pub const ERR_FFMPEG_FAILED: i64 = -32021;
pub const ERR_FFMPEG_TIMEOUT: i64 = -32022;
pub const ERR_FFMPEG_OUTPUT: i64 = -32023;

impl FfError {
    pub fn missing(tool: &str, searched: &str) -> Self {
        FfError {
            code: ERR_FFMPEG_MISSING,
            message: format!("{tool} not found ({searched}); the media toolchain is missing or damaged, please reinstall the application"),
            data: Some(json!({ "reason": "ffmpeg_missing", "tool": tool, "searched": searched, "recoverable": true, "action": "reinstall" })),
        }
    }
    pub fn failed(message: String, stderr: &str, exit: Option<i32>) -> Self {
        FfError {
            code: ERR_FFMPEG_FAILED,
            message,
            data: Some(json!({ "reason": "ffmpeg_failed", "exitCode": exit, "stderr": tail(stderr, 1000) })),
        }
    }
    pub fn timeout(tool: &str, secs: u64) -> Self {
        FfError {
            code: ERR_FFMPEG_TIMEOUT,
            message: format!("{tool} timed out after {secs}s"),
            data: Some(json!({ "reason": "ffmpeg_timeout", "tool": tool, "timeoutSec": secs })),
        }
    }
    pub fn output(message: String) -> Self {
        FfError { code: ERR_FFMPEG_OUTPUT, message, data: Some(json!({ "reason": "ffmpeg_bad_output" })) }
    }
}

/// Last `max` bytes of `s` (char-boundary safe).
pub fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.trim().to_string();
    }
    let mut i = s.len() - max;
    while !s.is_char_boundary(i) {
        i += 1;
    }
    s[i..].trim().to_string()
}

pub struct Output {
    pub status_ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Like `Output` but with stdout kept as raw bytes (rawvideo frames and other binary output).
pub struct RawOutput {
    pub status_ok: bool,
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

fn exe_names(tool: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{tool}.exe"), format!("{tool}.cmd"), format!("{tool}.bat")]
    } else {
        vec![tool.to_string()]
    }
}

fn find_in(dir: &Path, tool: &str) -> Option<PathBuf> {
    exe_names(tool).into_iter().map(|n| dir.join(n)).find(|p| p.is_file())
}

/// Resolve a tool. Order: explicit `dir` param, env LYCORE_FFMPEG_DIR, `<exe dir>/ffmpeg`,
/// then PATH. If a dir is explicitly configured it is authoritative (no fallback).
pub fn locate(tool: &str, dir_param: Option<&str>) -> Result<PathBuf, FfError> {
    let configured = dir_param
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var(ENV_DIR).ok().filter(|s| !s.is_empty()));
    if let Some(d) = configured {
        return find_in(Path::new(&d), tool).ok_or_else(|| FfError::missing(tool, &d));
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("ffmpeg"))) {
        if let Some(p) = find_in(&d, tool).or_else(|| find_in(&d.join("bin"), tool)) {
            return Ok(p);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&paths) {
            if let Some(p) = find_in(&d, tool) {
                return Ok(p);
            }
        }
    }
    Err(FfError::missing(tool, &format!("{ENV_DIR} unset, not beside lycore, not on PATH")))
}

/// Run `exe args` with a timeout; the child is killed on timeout/drop. stdout is decoded as text.
pub async fn run(exe: &Path, tool: &str, args: &[String], timeout_s: u64) -> Result<Output, FfError> {
    let o = run_raw(exe, tool, args, timeout_s).await?;
    Ok(Output {
        status_ok: o.status_ok,
        code: o.code,
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: o.stderr,
    })
}

/// Run `exe args` with a timeout, keeping stdout as raw bytes (for `-f rawvideo -` style output).
pub async fn run_raw(exe: &Path, tool: &str, args: &[String], timeout_s: u64) -> Result<RawOutput, FfError> {
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::PermissionDenied {
            FfError::missing(tool, &exe.display().to_string())
        } else {
            FfError::failed(format!("failed to start {tool}: {e}"), "", None)
        }
    })?;
    let mut so = child.stdout.take().expect("piped");
    let mut se = child.stderr.take().expect("piped");
    let work = async {
        let (mut a, mut b) = (Vec::new(), Vec::new());
        let _ = tokio::join!(so.read_to_end(&mut a), se.read_to_end(&mut b));
        let st = child.wait().await;
        (a, b, st)
    };
    match tokio::time::timeout(Duration::from_secs(timeout_s), work).await {
        Ok((a, b, st)) => {
            let st = st.map_err(|e| FfError::failed(format!("{tool} wait failed: {e}"), "", None))?;
            Ok(RawOutput {
                status_ok: st.success(),
                code: st.code(),
                stdout: a,
                stderr: String::from_utf8_lossy(&b).into_owned(),
            })
        }
        Err(_) => Err(FfError::timeout(tool, timeout_s)),
    }
}
