//! Reaching guests: HTTPS on the local network (cameras need a secure
//! context, and plain `http://192.168.x.y` is not one) and a Cloudflare quick
//! tunnel for guests on the internet. Both can be started and stopped while
//! streamFree runs.

use anyhow::{anyhow, bail, Context, Result};
use axum::Router;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// The address this machine uses to reach the network. No packet is sent:
/// connecting a UDP socket only selects a route.
pub fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/// Loads the self-signed certificate from `data_dir`, creating it on first use
/// so guests only accept the browser warning once.
fn certificate(data_dir: &Path, ip: IpAddr) -> Result<(Vec<u8>, Vec<u8>)> {
    let cert_path = data_dir.join("lan-cert.pem");
    let key_path = data_dir.join("lan-key.pem");
    let ip_marker = data_dir.join("lan-cert.ip");
    let same_ip = std::fs::read_to_string(&ip_marker).ok().as_deref() == Some(&ip.to_string());
    if same_ip {
        if let (Ok(cert), Ok(key)) = (std::fs::read(&cert_path), std::fs::read(&key_path)) {
            return Ok((cert, key));
        }
    }
    let names = vec!["localhost".to_string(), ip.to_string()];
    let certified = rcgen::generate_simple_self_signed(names).context("generate certificate")?;
    let cert = certified.cert.pem().into_bytes();
    let key = certified.key_pair.serialize_pem().into_bytes();
    std::fs::write(&cert_path, &cert)?;
    std::fs::write(&key_path, &key)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::write(&ip_marker, ip.to_string())?;
    Ok((cert, key))
}

/// A running HTTPS listener for guests on the local network.
pub struct LanServer {
    pub url: String,
    handle: axum_server::Handle,
}

impl LanServer {
    pub fn stop(&self) {
        self.handle.graceful_shutdown(Some(Duration::from_secs(2)));
    }
}

/// Serves `app` over HTTPS on all interfaces.
pub async fn serve_lan(app: Router, data_dir: &Path, port: u16) -> Result<LanServer> {
    let ip = lan_ip().ok_or_else(|| anyhow!("this computer is not connected to a network"))?;
    let (cert, key) = certificate(data_dir, ip)?;
    let config = axum_server::tls_rustls::RustlsConfig::from_pem(cert, key)
        .await
        .context("load certificate")?;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    // Bind first so a busy port is reported now, not in the background task.
    let std_listener =
        std::net::TcpListener::bind(addr).with_context(|| format!("port {port} is busy"))?;
    std_listener.set_nonblocking(true)?;
    let handle = axum_server::Handle::new();
    let server = axum_server::from_tcp_rustls(std_listener, config).handle(handle.clone());
    tokio::spawn(async move {
        if let Err(e) = server.serve(app.into_make_service()).await {
            tracing::error!("LAN server stopped: {e}");
        }
    });
    Ok(LanServer {
        url: format!("https://{ip}:{port}"),
        handle,
    })
}

/// Where cloudflared is installed, if it is. Apps started from Finder or the
/// Start menu do not see the shell's PATH, so common install locations are
/// checked too.
pub fn find_cloudflared() -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(custom) = std::env::var_os("STREAMFREE_CLOUDFLARED") {
        candidates.push(PathBuf::from(custom));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(exe)));
    }
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(dir) = std::env::var_os(var) {
                candidates.push(PathBuf::from(dir).join("cloudflared").join(exe));
            }
        }
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(dir).join(r"Microsoft\WinGet\Links").join(exe));
        }
    } else {
        for dir in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/snap/bin",
        ] {
            candidates.push(PathBuf::from(dir).join(exe));
        }
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local/bin").join(exe));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// A running Cloudflare quick tunnel to the local studio.
pub struct Tunnel {
    pub url: String,
    child: Child,
}

impl Tunnel {
    pub async fn stop(mut self) {
        let _ = self.child.kill().await;
    }
}

/// Starts `cloudflared tunnel --url http://127.0.0.1:<port>` and waits for the
/// public `https://*.trycloudflare.com` URL it prints. `on_exit` runs if the
/// tunnel process ends later on its own.
pub async fn start_tunnel(port: u16, on_exit: impl FnOnce() + Send + 'static) -> Result<Tunnel> {
    let program = find_cloudflared().ok_or_else(|| anyhow!("cloudflared is not installed"))?;
    let mut child = Command::new(program)
        .args([
            "tunnel",
            "--no-autoupdate",
            "--url",
            &format!("http://127.0.0.1:{port}"),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("start cloudflared")?;
    let stderr = child.stderr.take().context("no stderr")?;
    let mut lines = BufReader::new(stderr).lines();
    let found = tokio::time::timeout(Duration::from_secs(45), async {
        while let Some(line) = lines.next_line().await? {
            if let Some(url) = find_tunnel_url(&line) {
                return Ok::<_, std::io::Error>(Some(url));
            }
        }
        Ok(None)
    })
    .await;
    let url = match found {
        Ok(Ok(Some(url))) => url,
        Ok(Ok(None)) => bail!("cloudflared exited before printing an address"),
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => bail!("cloudflared did not print an address within 45 s"),
    };
    // Keep draining stderr so cloudflared never blocks on a full pipe; when it
    // closes, the process has ended.
    tokio::spawn(async move {
        while let Ok(Some(_)) = lines.next_line().await {}
        on_exit();
    });
    Ok(Tunnel { url, child })
}

fn find_tunnel_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..]
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '|')
        .collect();
    url.contains(".trycloudflare.com").then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_quick_tunnel_url() {
        let line = "2026-10-12T10:00:00Z INF |  https://quiet-river-1234.trycloudflare.com                          |";
        assert_eq!(
            find_tunnel_url(line).as_deref(),
            Some("https://quiet-river-1234.trycloudflare.com")
        );
        assert_eq!(
            find_tunnel_url("INF Requesting new quick Tunnel on trycloudflare.com..."),
            None
        );
    }

    #[test]
    fn cloudflared_override_is_used() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("my-cloudflared");
        std::fs::write(&fake, b"").unwrap();
        std::env::set_var("STREAMFREE_CLOUDFLARED", &fake);
        assert_eq!(find_cloudflared(), Some(fake));
        std::env::remove_var("STREAMFREE_CLOUDFLARED");
    }
}
