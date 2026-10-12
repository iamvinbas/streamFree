//! Reaching guests: HTTPS on the local network (cameras need a secure
//! context, and plain `http://192.168.x.y` is not one) and an optional
//! Cloudflare quick tunnel for guests on the internet.

use anyhow::{anyhow, bail, Context, Result};
use axum::Router;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

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

/// Serves `app` over HTTPS on all interfaces and returns the guest base URL.
pub async fn serve_lan(app: Router, data_dir: &Path, port: u16) -> Result<String> {
    let ip = lan_ip().ok_or_else(|| anyhow!("no network connection found"))?;
    let (cert, key) = certificate(data_dir, ip)?;
    let config = axum_server::tls_rustls::RustlsConfig::from_pem(cert, key)
        .await
        .context("load certificate")?;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    // Bind first so a busy port is reported now, not in the background task.
    let std_listener =
        std::net::TcpListener::bind(addr).with_context(|| format!("port {port} is busy"))?;
    std_listener.set_nonblocking(true)?;
    tokio::spawn(async move {
        let server = axum_server::from_tcp_rustls(std_listener, config);
        if let Err(e) = server.serve(app.into_make_service()).await {
            tracing::error!("LAN server stopped: {e}");
        }
    });
    Ok(format!("https://{ip}:{port}"))
}

static TUNNEL: Mutex<Option<Child>> = Mutex::const_new(None);

/// Starts `cloudflared tunnel --url http://127.0.0.1:<port>` and returns the
/// public `https://*.trycloudflare.com` URL it prints.
pub async fn start_tunnel(port: u16) -> Result<String> {
    let mut child = Command::new("cloudflared")
        .args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            anyhow!("could not run cloudflared ({e}). Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/")
        })?;
    let stderr = child.stderr.take().context("no stderr")?;
    *TUNNEL.lock().await = Some(child);
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
        Ok(Ok(None)) => bail!("cloudflared exited before printing a URL"),
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => bail!("cloudflared did not print a URL within 45 s"),
    };
    // Keep draining stderr so cloudflared never blocks on a full pipe.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    Ok(url)
}

pub async fn stop_tunnel() {
    if let Some(mut child) = TUNNEL.lock().await.take() {
        let _ = child.kill().await;
    }
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
}
