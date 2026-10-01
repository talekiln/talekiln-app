mod encoder;
mod ffmpeg;
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
async fn listen(endpoint: &str) -> std::io::Result<()> {
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

#[cfg(unix)]
async fn listen(endpoint: &str) -> std::io::Result<()> {
    // Unix domain socket fallback for Linux dev/CI.
    let _ = std::fs::remove_file(endpoint);
    let l = tokio::net::UnixListener::bind(endpoint)?;
    loop {
        let (conn, _) = l.accept().await?;
        tokio::spawn(serve(conn));
    }
}

#[tokio::main]
async fn main() {
    let Some(endpoint) = arg("--pipe") else {
        eprintln!("usage: lycore --pipe <endpoint> [--log-dir <dir>]");
        std::process::exit(2);
    };
    let log_dir = arg("--log-dir").unwrap_or_else(|| ".".into());
    let appender = tracing_appender::rolling::daily(log_dir, "lycore.log");
    let (nb, _guard) = tracing_appender::non_blocking(appender);
    tracing_subscriber::fmt().with_writer(nb).with_ansi(false).init();
    tracing::info!(endpoint = %endpoint, version = rpc::VERSION, "lycore starting");
    if let Err(e) = listen(&endpoint).await {
        tracing::error!(error = %e, "listener failed");
        std::process::exit(1);
    }
}
