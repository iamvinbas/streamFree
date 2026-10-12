//! Native desktop window (macOS and Windows): the studio runs in the system
//! WebView (WKWebView / WebView2) inside streamFree's own window, with its own
//! Dock/taskbar icon, menu bar and permission prompts.

use crate::server::Shared;
use anyhow::{Context, Result};
use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use std::time::Duration;
use tao::dpi::LogicalSize;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Window, WindowBuilder};
use wry::{WebView, WebViewBuilder};

#[derive(Debug)]
pub enum UserEvent {
    Menu(MenuEvent),
    /// The page is gone and any recording is finalized: safe to exit.
    ReadyToExit,
    Script(String),
    Minimize(bool),
}

pub struct Options {
    pub url: String,
    pub state: Shared,
    pub runtime: tokio::runtime::Runtime,
    pub shutdown: tokio::sync::oneshot::Sender<()>,
    pub server: tokio::task::JoinHandle<()>,
    /// Hidden smoke test: record for this many seconds, half of it with the
    /// window minimized, then quit.
    pub smoke_test: Option<u64>,
}

const QUIT_ID: &str = "streamfree.quit";

fn build_menu() -> Result<Menu> {
    let menu = Menu::new();
    let quit = MenuItem::with_id(
        QUIT_ID,
        "Quit streamFree",
        true,
        Some("CmdOrCtrl+Q".parse().context("accelerator")?),
    );
    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            "streamFree",
            true,
            &[
                &PredefinedMenuItem::about(Some("About streamFree"), None),
                &PredefinedMenuItem::separator(),
                &PredefinedMenuItem::hide(None),
                &PredefinedMenuItem::hide_others(None),
                &PredefinedMenuItem::show_all(None),
                &PredefinedMenuItem::separator(),
                &quit,
            ],
        )?;
        menu.append(&app_menu)?;
    }
    #[cfg(windows)]
    {
        let file_menu = Submenu::with_items("&File", true, &[&quit])?;
        menu.append(&file_menu)?;
    }
    // Without an Edit menu, copy and paste do not work in WKWebView fields.
    let edit_menu = Submenu::with_items(
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(None),
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::select_all(None),
        ],
    )?;
    menu.append(&edit_menu)?;
    let window_menu = Submenu::with_items(
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(None),
            &PredefinedMenuItem::fullscreen(None),
        ],
    )?;
    menu.append(&window_menu)?;
    Ok(menu)
}

/// Keeps macOS from napping or throttling streamFree while it runs: a live
/// show must keep its frame rate even when the window is hidden.
#[cfg(target_os = "macos")]
fn hold_activity() -> impl Sized {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let options = NSActivityOptions(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep.0
            | NSActivityOptions::LatencyCritical.0,
    );
    NSProcessInfo::processInfo()
        .beginActivityWithOptions_reason(options, &NSString::from_str("Live streaming studio"))
}

#[cfg(not(target_os = "macos"))]
fn hold_activity() -> impl Sized {}

fn begin_close(
    window: &Window,
    webview: &WebView,
    state: &Shared,
    runtime: &tokio::runtime::Runtime,
    proxy: &EventLoopProxy<UserEvent>,
) {
    // Unloading the page closes its connections, which ends any broadcast and
    // finalizes the recording on the server side. Wait for that, bounded.
    window.set_visible(false);
    let _ = webview.load_url("about:blank");
    let state = state.clone();
    let proxy = proxy.clone();
    runtime.spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if !state.is_live().await && state.studio_pages().0 == 0 {
                break;
            }
        }
        let _ = proxy.send_event(UserEvent::ReadyToExit);
    });
}

pub fn run(options: Options) -> Result<()> {
    let Options {
        url,
        state,
        runtime,
        shutdown,
        server,
        smoke_test,
    } = options;
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let menu = build_menu()?;
    {
        let proxy = proxy.clone();
        MenuEvent::set_event_handler(Some(move |event| {
            let _ = proxy.send_event(UserEvent::Menu(event));
        }));
    }

    let window = WindowBuilder::new()
        .with_title("streamFree")
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(LogicalSize::new(960.0, 620.0))
        .build(&event_loop)
        .context("create window")?;
    #[cfg(target_os = "macos")]
    menu.init_for_nsapp();
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        // SAFETY: the window handle is valid for the lifetime of `window`.
        unsafe { menu.init_for_hwnd(window.hwnd())? };
    }

    let origin = url
        .split_once("/?")
        .map(|(o, _)| o.to_owned())
        .unwrap_or_else(|| url.clone());
    let webview = WebViewBuilder::new()
        .with_url(&url)
        .with_autoplay(true)
        .with_devtools(cfg!(debug_assertions) || std::env::var_os("STREAMFREE_DEVTOOLS").is_some())
        .with_navigation_handler(move |target| {
            // Keep the studio in the window; open anything else in the browser.
            if target.starts_with(&origin) || target == "about:blank" {
                true
            } else {
                let _ = webbrowser::open(&target);
                false
            }
        })
        .build(&window)
        .context("create the studio view (is the system WebView available?)")?;

    let _activity = hold_activity();

    if let Some(seconds) = smoke_test {
        runtime.spawn(smoke_test_script(state.clone(), proxy.clone(), seconds));
    }

    let mut shutdown = Some(shutdown);
    let mut server = Some(server);
    let mut closing = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {}
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if !closing {
                    closing = true;
                    begin_close(&window, &webview, &state, &runtime, &proxy);
                }
            }
            Event::UserEvent(UserEvent::Menu(event)) => {
                if event.id.0 == QUIT_ID && !closing {
                    closing = true;
                    begin_close(&window, &webview, &state, &runtime, &proxy);
                }
            }
            Event::UserEvent(UserEvent::Script(script)) => {
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::Minimize(minimized)) => {
                window.set_minimized(minimized);
            }
            Event::UserEvent(UserEvent::ReadyToExit) => {
                if let Some(tx) = shutdown.take() {
                    let _ = tx.send(());
                }
                if let Some(handle) = server.take() {
                    let _ = runtime.block_on(async {
                        tokio::time::timeout(Duration::from_secs(5), handle).await
                    });
                }
                runtime.block_on(crate::sharing::shutdown(&state));
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

/// Records inside the real system WebView with the window minimized for half
/// of the time, then quits. Used before releases to check that the platform
/// WebView keeps encoding at full rate when the window is hidden.
async fn smoke_test_script(state: Shared, proxy: EventLoopProxy<UserEvent>, seconds: u64) {
    let wait_for = |want_live: bool| {
        let state = state.clone();
        async move {
            for _ in 0..600 {
                if state.is_live().await == want_live {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            false
        }
    };
    while state.studio_pages().0 == 0 {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    let _ = proxy.send_event(UserEvent::Script(
        "window.streamFree.startBroadcast('record', [])".into(),
    ));
    if !wait_for(true).await {
        eprintln!("smoke test: recording did not start");
        std::process::exit(2);
    }
    let half = Duration::from_millis(seconds * 500);
    tokio::time::sleep(half).await;
    let _ = proxy.send_event(UserEvent::Minimize(true));
    tokio::time::sleep(half).await;
    let _ = proxy.send_event(UserEvent::Minimize(false));
    let _ = proxy.send_event(UserEvent::Script(
        "window.streamFree.stopBroadcast()".into(),
    ));
    if !wait_for(false).await {
        eprintln!("smoke test: recording did not stop");
        std::process::exit(2);
    }
    println!("smoke test: recording finished");
    let _ = proxy.send_event(UserEvent::ReadyToExit);
}
