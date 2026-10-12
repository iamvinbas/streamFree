//! streamFree: a free, local live-streaming studio in one binary.

use anyhow::{Context, Result};
use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;
use streamfree::{net, server, store};

#[derive(Parser, Debug)]
#[command(
    name = "streamfree",
    version,
    about = "Free, local live-streaming studio: guests, multistreaming and recording."
)]
struct Cli {
    /// Port of the studio (HTTP, on this computer only).
    #[arg(long, default_value_t = 8787)]
    port: u16,

    /// Also serve guests on your local network over HTTPS (self-signed
    /// certificate, port + 1). Guests see a browser warning the first time.
    #[arg(long)]
    lan: bool,

    /// Expose the guest page on the internet with a Cloudflare quick tunnel.
    /// Needs `cloudflared` installed.
    #[arg(long)]
    tunnel: bool,

    /// Public base URL when you run your own HTTPS reverse proxy
    /// (e.g. https://studio.example.com). Used for invite links.
    #[arg(long)]
    public_url: Option<String>,

    /// Where settings and uploaded assets live.
    #[arg(long)]
    data_dir: Option<PathBuf>,

    /// Where recordings are saved.
    #[arg(long)]
    recordings_dir: Option<PathBuf>,

    /// Do not open the studio in the browser.
    #[arg(long)]
    no_open: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "streamfree=info".into()),
        )
        .with_target(false)
        .init();
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cli = Cli::parse();
    let data_dir = cli.data_dir.clone().unwrap_or_else(store::default_data_dir);
    let recordings_dir = cli
        .recordings_dir
        .clone()
        .unwrap_or_else(store::default_recordings_dir);
    let store = store::Store::open(data_dir.clone())?;

    let addr = SocketAddr::from(([127, 0, 0, 1], cli.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("port {} is busy; try --port {}", cli.port, cli.port + 2))?;
    let local_url = format!("http://localhost:{}", cli.port);
    let state = server::AppState::new(store, recordings_dir.clone(), local_url);
    let app = server::router(state.clone());

    if let Some(url) = cli.public_url.clone() {
        *state.public_url.write().await = Some(url.trim_end_matches('/').to_owned());
    }
    if cli.lan {
        let lan_port = cli.port + 1;
        match net::serve_lan(app.clone(), &data_dir, lan_port).await {
            Ok(url) => *state.lan_url.write().await = Some(url),
            Err(e) => tracing::warn!("LAN guests disabled: {e:#}"),
        }
    }
    if cli.tunnel {
        let state = state.clone();
        let port = cli.port;
        tokio::spawn(async move {
            match net::start_tunnel(port).await {
                Ok(url) => {
                    tracing::info!("guests can join from anywhere through {url}");
                    *state.public_url.write().await = Some(url);
                    tracing::info!("invite link: {}", state.invite_url().await);
                }
                Err(e) => tracing::warn!("tunnel not started: {e:#}"),
            }
        });
    }

    let host_url = state.host_url().await;
    println!();
    println!("  streamFree {} is running", env!("CARGO_PKG_VERSION"));
    println!("  Studio:      {host_url}");
    println!("  Invite link: {}", state.invite_url().await);
    println!("  Recordings:  {}", recordings_dir.display());
    println!("  Settings:    {}", data_dir.display());
    println!("  Press Ctrl+C to quit.");
    println!();
    if !cli.no_open {
        if let Err(e) = webbrowser::open(&host_url) {
            tracing::warn!(
                "could not open the browser ({e}); open the studio link above in Chrome or Edge"
            );
        }
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    net::stop_tunnel().await;
    Ok(())
}
