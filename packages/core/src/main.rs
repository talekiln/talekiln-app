mod encoder;
mod ffmpeg;
mod licence;
mod media;
mod plan;
mod render;
mod rpc;
mod sha256;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

/// Newline-delimited JSON-RPC 2.0 over any duplex stream.
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(stream: S) {
    let (r, mut w) = tokio::io::split(stream);
    let mut lines = BufReader::new(r).lines();
    let mut notes = render::subscribe();
    loop {
        let out = tokio::select! {
            l = lines.next_line() => match l {
                Ok(Some(line)) => {
                    if line.trim().is_empty() { continue; }
                    match rpc::handle_line(&line).await { Some(r) => r, None => continue }
                }
                _ => break,
            },
            n = notes.recv() => match n {
                Ok(v) => v,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
        };
        let mut s = out.to_string();
        s.push('\n');
        if w.write_all(s.as_bytes()).await.is_err() {
            break;
        }
    }
}

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}

#[cfg(windows)]
async fn listen(endpoint: &str, _initial_parent: u32) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    // e.g. \\.\pipe\lycore-<id>
    let mut server = ServerOptions::new().first_pipe_instance(true).create(endpoint)?;
    loop {
        server.connect().await?;
        let next = ServerOptions::new().create(endpoint)?;
        let conn = std::mem::replace(&mut server, next);
        tokio::spawn(serve(conn));
    }
}

/// Pure: has the original parent gone away (we were re-parented to init/launchd)?
#[cfg(unix)]
fn parent_changed(initial: u32, current: u32) -> bool {
    initial != current
}

/// Resolves when the process should stop: SIGTERM/SIGINT/SIGHUP, or (opt-in via LYCORE_WATCH_PARENT=1)
/// when the parent process died, so a crashed/force-quit desktop app does not leave lycore behind.
#[cfg(unix)]
async fn shutdown_signal(initial_parent: u32) {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int), Ok(mut hup)) =
        (signal(SignalKind::terminate()), signal(SignalKind::interrupt()), signal(SignalKind::hangup()))
    else {
        std::future::pending::<()>().await;
        return;
    };
    let watch_parent = std::env::var("LYCORE_WATCH_PARENT").map(|v| v == "1").unwrap_or(false);
    let initial = initial_parent;
    let parent = async {
        if !watch_parent {
            return std::future::pending::<()>().await;
        }
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tick.tick().await;
            if parent_changed(initial, std::os::unix::process::parent_id()) {
                return;
            }
        }
    };
    tokio::select! {
        _ = term.recv() => tracing::info!("SIGTERM received"),
        _ = int.recv() => tracing::info!("SIGINT received"),
        _ = hup.recv() => tracing::info!("SIGHUP received"),
        _ = parent => tracing::info!("parent process exited"),
    }
}

#[cfg(unix)]
async fn listen(endpoint: &str, initial_parent: u32) -> std::io::Result<()> {
    // Unix domain socket (macOS and Linux). Note macOS limits the path to 103 bytes (Linux 107);
    // the desktop app picks a short path (see apps/desktop/core-runtime.js makeEndpoint).
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::remove_file(endpoint);
    let l = tokio::net::UnixListener::bind(endpoint)?;
    // Owner-only: other local users must not be able to drive the renderer.
    let _ = std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600));
    let accept = async {
        loop {
            let (conn, _) = l.accept().await?;
            tokio::spawn(serve(conn));
        }
        #[allow(unreachable_code)]
        Ok::<(), std::io::Error>(())
    };
    let r = tokio::select! {
        r = accept => r,
        _ = shutdown_signal(initial_parent) => Ok(()),
    };
    // Leave no stale socket behind; returning from main drops the runtime, which kills running ffmpeg children.
    let _ = std::fs::remove_file(endpoint);
    r
}

#[tokio::main]
async fn main() {
    // Recorded before anything else so a parent that dies right after spawning us is still noticed.
    #[cfg(unix)]
    let initial_parent = std::os::unix::process::parent_id();
    #[cfg(not(unix))]
    let initial_parent = 0u32;
    let Some(endpoint) = arg("--pipe") else {
        eprintln!("usage: lycore --pipe <endpoint> [--log-dir <dir>]");
        std::process::exit(2);
    };
    let log_dir = arg("--log-dir").unwrap_or_else(|| ".".into());
    let appender = tracing_appender::rolling::daily(log_dir, "lycore.log");
    let (nb, _guard) = tracing_appender::non_blocking(appender);
    tracing_subscriber::fmt().with_writer(nb).with_ansi(false).init();
    tracing::info!(endpoint = %endpoint, version = rpc::VERSION, "lycore starting");
    if let Err(e) = listen(&endpoint, initial_parent).await {
        tracing::error!(error = %e, "listener failed");
        std::process::exit(1);
    }
    tracing::info!("lycore stopped");
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn parent_change_detection() {
        assert!(!parent_changed(100, 100));
        assert!(parent_changed(100, 1)); // re-parented to init/launchd
    }
}
