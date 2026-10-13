//! Who can join as a guest: only this computer, the local network (HTTPS with
//! a self-signed certificate) or anyone on the internet (Cloudflare quick
//! tunnel). The mode can change while streamFree runs; the studio is told
//! about every change so the invite link it shows is always current.

use crate::net::{self, LanServer, Tunnel};
use crate::server::Shared;
use crate::store::SharingMode;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum TunnelState {
    Off,
    Starting,
    On,
    Error(String),
}

pub struct Sharing {
    pub mode: SharingMode,
    pub lan: Option<LanServer>,
    pub lan_error: Option<String>,
    pub tunnel: Option<Tunnel>,
    pub tunnel_state: TunnelState,
    /// Bumped on every mode change, so a tunnel that finishes starting after
    /// the host changed their mind is shut down instead of used.
    generation: u64,
    /// Generation that started the current tunnel.
    tunnel_generation: u64,
}

impl Default for Sharing {
    fn default() -> Self {
        Self {
            mode: SharingMode::Local,
            lan: None,
            lan_error: None,
            tunnel: None,
            tunnel_state: TunnelState::Off,
            generation: 0,
            tunnel_generation: 0,
        }
    }
}

impl Sharing {
    /// Base URL guests should use right now.
    pub fn guest_base(&self) -> Option<String> {
        match self.mode {
            SharingMode::Internet => self.tunnel.as_ref().map(|t| t.url.clone()),
            SharingMode::Lan => self.lan.as_ref().map(|l| l.url.clone()),
            SharingMode::Local => None,
        }
    }
}

/// Current state, as sent to the studio.
pub async fn status(state: &Shared) -> Value {
    let invite_url = state.invite_url().await;
    let s = state.sharing.lock().await;
    let (tunnel_state, tunnel_error) = match &s.tunnel_state {
        TunnelState::Off => ("off", None),
        TunnelState::Starting => ("starting", None),
        TunnelState::On => ("on", None),
        TunnelState::Error(e) => ("error", Some(e.clone())),
    };
    json!({
        "mode": s.mode,
        "inviteUrl": invite_url,
        "lanUrl": s.lan.as_ref().map(|l| l.url.clone()),
        "lanError": s.lan_error,
        "tunnel": {
            "state": tunnel_state,
            "url": s.tunnel.as_ref().map(|t| t.url.clone()),
            "error": tunnel_error,
        },
        "cloudflared": net::find_cloudflared().is_some(),
        "customUrl": state.public_url.read().await.clone(),
    })
}

async fn notify(state: &Shared) {
    let mut value = status(state).await;
    value["type"] = "sharing".into();
    state.emit(value);
}

/// Switches to `mode`: starts or stops the LAN listener and the tunnel.
/// Returns once the LAN listener is up; the tunnel keeps starting in the
/// background and the studio is notified when it is ready.
pub async fn set_mode(state: &Shared, mode: SharingMode) {
    let generation;
    {
        let mut s = state.sharing.lock().await;
        s.mode = mode;
        s.generation += 1;
        generation = s.generation;

        if mode == SharingMode::Lan {
            if s.lan.is_none() {
                match state.router() {
                    Some(router) => {
                        match net::serve_lan(router, &state.data_dir, state.port + 1).await {
                            Ok(lan) => {
                                tracing::info!("guests on the local network: {}", lan.url);
                                s.lan = Some(lan);
                                s.lan_error = None;
                            }
                            Err(e) => s.lan_error = Some(format!("{e:#}")),
                        }
                    }
                    None => s.lan_error = Some("server not ready".into()),
                }
            }
        } else {
            if let Some(lan) = s.lan.take() {
                lan.stop();
            }
            s.lan_error = None;
        }

        if mode == SharingMode::Internet {
            if s.tunnel.is_none() && s.tunnel_state != TunnelState::Starting {
                s.tunnel_state = TunnelState::Starting;
                tokio::spawn(start_tunnel(state.clone(), generation, 1));
            }
        } else {
            if let Some(tunnel) = s.tunnel.take() {
                tunnel.stop().await;
            }
            s.tunnel_state = TunnelState::Off;
        }
    }
    notify(state).await;
}

/// How many times in a row a failed or dropped tunnel is started again before
/// the studio shows the error.
const TUNNEL_ATTEMPTS: u32 = 4;

fn retry_tunnel(state: Shared, generation: u64, attempt: u32) {
    let next: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
        Box::pin(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2 * u64::from(attempt))).await;
            start_tunnel(state, generation, attempt).await;
        });
    tokio::spawn(next);
}

async fn start_tunnel(state: Shared, generation: u64, attempt: u32) {
    let watcher = state.clone();
    let result = net::start_tunnel(state.port, move || {
        // The tunnel process ended on its own (network change, crash): start
        // a new one. Its address differs, and the studio is told.
        tokio::spawn(async move {
            {
                let mut s = watcher.sharing.lock().await;
                // Ignore tunnels that were stopped on purpose or replaced.
                if s.tunnel.is_none() || s.tunnel_generation != generation {
                    return;
                }
                s.tunnel = None;
                s.tunnel_state = TunnelState::Starting;
            }
            tracing::warn!("the internet link stopped; starting a new one");
            notify(&watcher).await;
            retry_tunnel(watcher, generation, 1);
        });
    })
    .await;
    {
        let mut s = state.sharing.lock().await;
        let still_wanted = s.generation == generation && s.mode == SharingMode::Internet;
        match result {
            Ok(tunnel) if still_wanted => {
                tracing::info!("guests on the internet: {}", tunnel.url);
                s.tunnel = Some(tunnel);
                s.tunnel_generation = generation;
                s.tunnel_state = TunnelState::On;
            }
            Ok(tunnel) => tunnel.stop().await,
            Err(e)
                if still_wanted
                    && attempt < TUNNEL_ATTEMPTS
                    && net::find_cloudflared().is_some() =>
            {
                tracing::warn!("internet link attempt {attempt} failed: {e:#}");
                drop(s);
                retry_tunnel(state.clone(), generation, attempt + 1);
                return;
            }
            Err(e) if still_wanted => s.tunnel_state = TunnelState::Error(format!("{e:#}")),
            Err(_) => {}
        }
        if !still_wanted && s.mode != SharingMode::Internet {
            s.tunnel_state = TunnelState::Off;
        }
    }
    notify(&state).await;
}

/// Stops the LAN listener and the tunnel (when streamFree quits).
pub async fn shutdown(state: &Shared) {
    let mut s = state.sharing.lock().await;
    if let Some(lan) = s.lan.take() {
        lan.stop();
    }
    if let Some(tunnel) = s.tunnel.take() {
        tunnel.stop().await;
    }
}
