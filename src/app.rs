//! Desktop app mode: the studio opens in its own browser window (no tabs, no
//! address bar) and streamFree quits when that window is closed.
//!
//! The window is a Chromium-family browser started with `--app` and a
//! dedicated profile, so it runs as a separate instance that streamFree can
//! close without touching the user's own browser windows.

use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

/// True when this executable runs from inside a macOS `.app` bundle, which
/// is how Finder, the Dock, Launchpad and Spotlight start it.
pub fn launched_from_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.canonicalize().ok())
        .is_some_and(|exe| {
            let s = exe.to_string_lossy();
            s.contains(".app/Contents/MacOS/")
        })
}

fn browser_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(custom) = std::env::var_os("STREAMFREE_BROWSER") {
        out.push(PathBuf::from(custom));
    }
    if cfg!(target_os = "macos") {
        let apps = [
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Brave Browser.app/Contents/MacOS/Brave Browser",
            "Chromium.app/Contents/MacOS/Chromium",
            "Vivaldi.app/Contents/MacOS/Vivaldi",
        ];
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join("Applications"));
        }
        for app in apps {
            for root in &roots {
                out.push(root.join(app));
            }
        }
    } else if cfg!(windows) {
        let roots: Vec<PathBuf> = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(|v| std::env::var_os(v).map(PathBuf::from))
            .collect();
        let exes = [
            r"Google\Chrome\Application\chrome.exe",
            r"Microsoft\Edge\Application\msedge.exe",
            r"BraveSoftware\Brave-Browser\Application\brave.exe",
        ];
        for exe in exes {
            for root in &roots {
                out.push(root.join(exe));
            }
        }
    } else {
        let names = [
            "google-chrome-stable",
            "google-chrome",
            "chromium",
            "chromium-browser",
            "microsoft-edge-stable",
            "microsoft-edge",
            "brave-browser",
        ];
        let path = std::env::var_os("PATH").unwrap_or_default();
        for name in names {
            for dir in std::env::split_paths(&path) {
                out.push(dir.join(name));
            }
        }
    }
    out
}

/// The first installed Chromium-family browser (Chrome, Edge, Brave, …).
pub fn find_browser() -> Option<PathBuf> {
    browser_candidates().into_iter().find(|p| p.is_file())
}

/// Opens `url` as a standalone app window. Returns the browser process.
pub fn open_window(browser: &Path, url: &str, profile_dir: &Path) -> Result<Child> {
    std::fs::create_dir_all(profile_dir)?;
    let child = Command::new(browser)
        .arg(format!("--app={url}"))
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .args([
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=1440,900",
            "--class=streamFree",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    Ok(child)
}

/// Checks whether a streamFree server that accepts `token` already runs on
/// `port` (for example when the app is opened twice).
pub async fn existing_instance(port: u16, token: &str) -> bool {
    let attempt = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        let request = format!(
            "GET /api/info HTTP/1.1\r\nHost: localhost\r\nx-streamfree-token: {token}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await?;
        let mut head = [0u8; 12];
        stream.read_exact(&mut head).await?;
        Ok::<_, std::io::Error>(head.starts_with(b"HTTP/1.1 200"))
    };
    matches!(
        tokio::time::timeout(Duration::from_secs(2), attempt).await,
        Ok(Ok(true))
    )
}

/// Detaches from the console window Windows opens for the app shortcut.
#[cfg(windows)]
pub fn hide_console() {
    // SAFETY: FreeConsole has no preconditions; failure only means there was
    // no console to detach from.
    unsafe {
        windows_sys::Win32::System::Console::FreeConsole();
    }
}

#[cfg(not(windows))]
pub fn hide_console() {}

/// Shows a native error message when there is no terminal to print to.
pub fn alert(message: &str) {
    if cfg!(target_os = "macos") {
        let script = format!(
            "display alert \"streamFree\" message {} as critical",
            applescript_string(message)
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .status();
    } else {
        eprintln!("streamFree: {message}");
    }
}

fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Fails with a helpful message when no suitable browser is installed.
pub fn require_browser() -> Result<PathBuf> {
    match find_browser() {
        Some(path) => Ok(path),
        None => bail!(
            "streamFree needs Google Chrome, Microsoft Edge or Brave to show the studio. Install one of them and open streamFree again."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_applescript_strings() {
        assert_eq!(applescript_string(r#"a "b" \c"#), r#""a \"b\" \\c""#);
    }

    #[test]
    fn browser_override_is_tried_first() {
        std::env::set_var("STREAMFREE_BROWSER", "/nonexistent/browser");
        assert_eq!(
            browser_candidates().first(),
            Some(&PathBuf::from("/nonexistent/browser"))
        );
        std::env::remove_var("STREAMFREE_BROWSER");
    }
}
