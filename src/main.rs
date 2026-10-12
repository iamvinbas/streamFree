//! streamFree: a free, local live-streaming studio in one binary.

use anyhow::Result;
use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use streamfree::{app, net, server, store};

/// Whether this build has the native desktop window (system WebView).
const NATIVE_WINDOW: bool = cfg!(any(target_os = "macos", windows));

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

    /// With --app: show the studio in a Chrome/Edge/Brave window instead of
    /// streamFree's own window.
    #[arg(long)]
    browser: bool,

    /// Release check: record for N seconds in the app window, half of the
    /// time minimized, then quit.
    #[arg(long, hide = true, value_name = "SECONDS")]
    smoke_test: Option<u64>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let app_mode = cli.app || cli.smoke_test.is_some() || app::launched_from_bundle();
    let native = app_mode && !cli.browser && NATIVE_WINDOW;
    let data_dir = cli.data_dir.clone().unwrap_or_else(store::default_data_dir);
    let quiet = app_mode && cli.smoke_test.is_none();
    init_logging(quiet, &data_dir);
    let _ = rustls::crypto::ring::default_provider().install_default();
    if quiet {
        app::hide_console();
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = if native {
        run_native(runtime, cli, data_dir)
    } else {
        runtime.block_on(run_in_browser(cli, data_dir, app_mode))
    };
    if let Err(e) = &result {
        if quiet {
            tracing::error!("{e:#}");
            app::alert(&format!("{e:#}"));
        }
    }
    result
}

/// Logs go to the terminal, or to `streamfree.log` in the data directory when
/// there is no terminal (app mode).
fn init_logging(to_file: bool, data_dir: &std::path::Path) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "streamfree=info".into());
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false);
    if to_file {
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

async fn bind(port: u16) -> std::io::Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await
}

fn busy_error(e: std::io::Error, port: u16) -> anyhow::Error {
    anyhow::Error::new(e).context(format!("port {port} is busy; try --port {}", port + 2))
}

/// Builds the server state and starts the optional LAN listener and tunnel.
/// Returns the state, the router and the studio URL.
async fn setup(
    cli: &Cli,
    data_dir: &std::path::Path,
    store: store::Store,
    quit_hint: &str,
) -> (server::Shared, axum::Router, String) {
    let recordings_dir = cli
        .recordings_dir
        .clone()
        .unwrap_or_else(store::default_recordings_dir);
    let local_url = format!("http://localhost:{}", cli.port);
    let state = server::AppState::new(store, recordings_dir.clone(), local_url);
    let router = server::router(state.clone());

    if let Some(url) = cli.public_url.clone() {
        *state.public_url.write().await = Some(url.trim_end_matches('/').to_owned());
    }
    if cli.lan {
        match net::serve_lan(router.clone(), data_dir, cli.port + 1).await {
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
    println!("  {quit_hint}");
    println!();
    (state, router, host_url)
}

/// streamFree's own window with the system WebView (macOS, Windows).
#[cfg(any(target_os = "macos", windows))]
fn run_native(runtime: tokio::runtime::Runtime, cli: Cli, data_dir: PathBuf) -> Result<()> {
    let store = store::Store::open(data_dir.clone())?;
    let listener = match runtime.block_on(bind(cli.port)) {
        Ok(listener) => listener,
        Err(e) => {
            let token = store.settings.host_token.clone();
            if runtime.block_on(app::existing_instance(cli.port, &token)) {
                app::alert("streamFree is already open.");
                return Ok(());
            }
            return Err(busy_error(e, cli.port));
        }
    };
    let (state, router, mut url) =
        runtime.block_on(setup(&cli, &data_dir, store, "Close the window to quit."));
    if cli.smoke_test.is_some() {
        url.push_str("&nodevices=1");
    }
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = runtime.spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
        if let Err(e) = result {
            tracing::error!("server stopped: {e}");
        }
    });
    streamfree::desktop::run(streamfree::desktop::Options {
        url,
        state,
        runtime,
        shutdown,
        server,
        smoke_test: cli.smoke_test,
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn run_native(_: tokio::runtime::Runtime, _: Cli, _: PathBuf) -> Result<()> {
    unreachable!("no native window on this platform")
}

/// Terminal mode (studio in a browser tab) and the browser-window app mode
/// used on Linux or with --browser.
async fn run_in_browser(cli: Cli, data_dir: PathBuf, app_mode: bool) -> Result<()> {
    let store = store::Store::open(data_dir.clone())?;
    let browser = if app_mode {
        Some(app::require_browser()?)
    } else {
        None
    };
    let listener = match bind(cli.port).await {
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
            return Err(busy_error(e, cli.port));
        }
    };
    let hint = if app_mode {
        "Close the studio window to quit."
    } else {
        "Press Ctrl+C to quit."
    };
    let (state, router, host_url) = setup(&cli, &data_dir, store, hint).await;

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
