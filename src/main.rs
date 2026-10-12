//! streamFree: a free, local live-streaming studio in one binary.

use anyhow::{Context, Result};
use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use streamfree::{app, net, server, store};

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

    /// Desktop app mode: open the studio in its own window and quit when it
    /// is closed. On by default when started from the macOS app bundle.
    #[arg(long)]
    app: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let app_mode = cli.app || app::launched_from_bundle();
    let data_dir = cli.data_dir.clone().unwrap_or_else(store::default_data_dir);
    init_logging(app_mode, &data_dir);
    let _ = rustls::crypto::ring::default_provider().install_default();

    if app_mode {
        app::hide_console();
        if let Err(e) = run(cli, data_dir, true).await {
            tracing::error!("{e:#}");
            app::alert(&format!("{e:#}"));
            return Err(e);
        }
        return Ok(());
    }
    run(cli, data_dir, false).await
}

/// Logs go to the terminal, or to `streamfree.log` in the data directory when
/// there is no terminal (app mode).
fn init_logging(app_mode: bool, data_dir: &std::path::Path) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "streamfree=info".into());
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false);
    if app_mode {
        let _ = std::fs::create_dir_all(data_dir);
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(data_dir.join("streamfree.log"))
        {
            builder
                .with_ansi(false)
                .with_writer(std::sync::Mutex::new(file))
                .init();
            return;
        }
    }
    builder.init();
}

async fn run(cli: Cli, data_dir: PathBuf, app_mode: bool) -> Result<()> {
    let recordings_dir = cli
        .recordings_dir
        .clone()
        .unwrap_or_else(store::default_recordings_dir);
    let store = store::Store::open(data_dir.clone())?;
    let browser = if app_mode {
        Some(app::require_browser()?)
    } else {
        None
    };

    let addr = SocketAddr::from(([127, 0, 0, 1], cli.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(e) => {
            // Opened twice: show the window of the instance already running.
            let token = store.settings.host_token.clone();
            if let Some(browser) = &browser {
                if app::existing_instance(cli.port, &token).await {
                    let url = format!("http://localhost:{}/?t={token}", cli.port);
                    let mut child = app::open_window(browser, &url, &data_dir.join("browser"))?;
                    let _ = child.wait().await;
                    return Ok(());
                }
            }
            return Err(e).with_context(|| {
                format!("port {} is busy; try --port {}", cli.port, cli.port + 2)
            });
        }
    };
    let local_url = format!("http://localhost:{}", cli.port);
    let state = server::AppState::new(store, recordings_dir.clone(), local_url);
    let router = server::router(state.clone());

    if let Some(url) = cli.public_url.clone() {
        *state.public_url.write().await = Some(url.trim_end_matches('/').to_owned());
    }
    if cli.lan {
        let lan_port = cli.port + 1;
        match net::serve_lan(router.clone(), &data_dir, lan_port).await {
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
    println!(
        "  {}",
        if app_mode {
            "Close the studio window to quit."
        } else {
            "Press Ctrl+C to quit."
        }
    );
    println!();

    let (quit_tx, quit_rx) = tokio::sync::oneshot::channel::<()>();
    let mut window = None;
    if let Some(browser) = &browser {
        window = Some(app::open_window(
            browser,
            &host_url,
            &data_dir.join("browser"),
        )?);
        tokio::spawn(quit_when_studio_closed(state.clone(), quit_tx));
    } else if !cli.no_open {
        if let Err(e) = webbrowser::open(&host_url) {
            tracing::warn!(
                "could not open the browser ({e}); open the studio link above in Chrome or Edge"
            );
        }
    }

    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = quit_rx => {}
            }
        })
        .await?;
    if let Some(mut window) = window {
        let _ = window.kill().await;
    }
    net::stop_tunnel().await;
    Ok(())
}

/// App mode: quit once the studio has been closed for a few seconds (a page
/// reload reconnects well within that) and any recording has been finalized.
async fn quit_when_studio_closed(state: server::Shared, quit: tokio::sync::oneshot::Sender<()>) {
    const GRACE: Duration = Duration::from_secs(5);
    const FIRST_LOAD: Duration = Duration::from_secs(120);
    let started = tokio::time::Instant::now();
    let mut seen = false;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let (pages, unchanged_for) = state.studio_pages();
        if pages > 0 {
            seen = true;
            continue;
        }
        let closed = if seen {
            unchanged_for >= GRACE
        } else {
            started.elapsed() >= FIRST_LOAD
        };
        if closed && !state.is_live().await {
            tracing::info!("studio window closed; quitting");
            let _ = quit.send(());
            return;
        }
    }
}
