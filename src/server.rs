//! HTTP and WebSocket server: serves the studio and guest pages, relays WebRTC
//! signaling between host and guests, receives encoded media from the studio
//! and exposes the settings API.
//!
//! Access model:
//! * the host holds `host_token` (in the URL the app opens) and may do anything;
//! * guests hold `invite_token` (in the invite link) and may only join the
//!   signaling room. Stream keys never leave this process.

use crate::chat;
use crate::live::{DestinationSpec, Session, SessionOptions};
use crate::media::{AudioConfig, Packet, StreamConfig, Track, VideoConfig};
use crate::rtmp::Target;
use crate::store::{random_token, Destination, IceServer, Store};
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, watch, Mutex, RwLock};

#[derive(RustEmbed)]
#[folder = "web/"]
struct Web;

const MAX_GUESTS: usize = 16;
const MAX_ASSET_BYTES: usize = 512 * 1024 * 1024;

struct Guest {
    name: String,
    tx: mpsc::Sender<String>,
}

pub struct AppState {
    pub store: Mutex<Store>,
    pub recordings_dir: PathBuf,
    pub local_url: String,
    /// Settings directory (LAN certificate lives here).
    pub data_dir: PathBuf,
    /// Port of the local studio; the LAN listener uses port + 1.
    pub port: u16,
    /// Base URL of the host's own HTTPS proxy (--public-url), if any.
    pub public_url: RwLock<Option<String>>,
    pub sharing: Mutex<crate::sharing::Sharing>,
    router: std::sync::OnceLock<Router>,
    host_tx: Mutex<Option<mpsc::Sender<String>>>,
    guests: Mutex<HashMap<String, Guest>>,
    events: broadcast::Sender<Value>,
    live: Mutex<bool>,
    /// Open studio pages, and when the count last changed (app mode quits
    /// when the studio window has been closed for a few seconds).
    studio_pages: std::sync::Mutex<(usize, Instant)>,
    chat: Mutex<Option<(String, watch::Sender<bool>)>>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new(store: Store, recordings_dir: PathBuf, data_dir: PathBuf, port: u16) -> Shared {
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            store: Mutex::new(store),
            recordings_dir,
            local_url: format!("http://localhost:{port}"),
            data_dir,
            port,
            public_url: RwLock::new(None),
            sharing: Mutex::new(crate::sharing::Sharing::default()),
            router: std::sync::OnceLock::new(),
            host_tx: Mutex::new(None),
            guests: Mutex::new(HashMap::new()),
            events,
            live: Mutex::new(false),
            studio_pages: std::sync::Mutex::new((0, Instant::now())),
            chat: Mutex::new(None),
        })
    }

    pub async fn host_url(&self) -> String {
        let token = self.store.lock().await.settings.host_token.clone();
        format!("{}/?t={token}", self.local_url)
    }

    /// The router, for listeners started later (the LAN listener).
    pub fn set_router(&self, router: Router) {
        let _ = self.router.set(router);
    }

    pub fn router(&self) -> Option<Router> {
        self.router.get().cloned()
    }

    /// Sends an event to the open studio pages.
    pub fn emit(&self, value: Value) {
        let _ = self.events.send(value);
    }

    pub async fn invite_url(&self) -> String {
        let custom = self.public_url.read().await.clone();
        let base = match custom {
            Some(url) => url,
            None => self
                .sharing
                .lock()
                .await
                .guest_base()
                .unwrap_or_else(|| self.local_url.clone()),
        };
        let invite = self.store.lock().await.settings.invite_token.clone();
        format!("{}/join/{invite}", base.trim_end_matches('/'))
    }

    /// Whether a broadcast or recording is in progress.
    pub async fn is_live(&self) -> bool {
        *self.live.lock().await
    }

    /// Number of open studio pages and how long that number has held.
    pub fn studio_pages(&self) -> (usize, Duration) {
        let (count, since) = *self.studio_pages.lock().unwrap();
        (count, since.elapsed())
    }

    fn studio_page_delta(&self, opened: bool) {
        let mut pages = self.studio_pages.lock().unwrap();
        pages.0 = if opened {
            pages.0 + 1
        } else {
            pages.0.saturating_sub(1)
        };
        pages.1 = Instant::now();
    }

    async fn to_host(&self, value: Value) {
        if let Some(tx) = self.host_tx.lock().await.as_ref() {
            let _ = tx.try_send(value.to_string());
        }
    }
}

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/", get(studio_page))
        .route("/join/{invite}", get(guest_page))
        .route("/static/{*path}", get(static_file))
        .route("/api/info", get(info))
        .route(
            "/api/destinations",
            get(list_destinations).post(save_destination),
        )
        .route(
            "/api/destinations/{id}",
            axum::routing::delete(delete_destination),
        )
        .route("/api/destinations/{id}/test", post(test_destination))
        .route("/api/sharing", get(get_sharing).put(put_sharing))
        .route("/api/invite/qr.svg", get(invite_qr))
        .route("/api/studio", get(get_studio).put(put_studio))
        .route("/api/ice", put(put_ice))
        .route("/api/invite/reset", post(reset_invite))
        .route(
            "/api/assets",
            post(upload_asset).layer(DefaultBodyLimit::max(MAX_ASSET_BYTES)),
        )
        .route("/api/assets/{id}", get(get_asset))
        .route("/api/chat/twitch", post(start_twitch).delete(stop_twitch))
        .route("/api/recordings/open", post(open_recordings))
        .route("/ws/host", get(host_ws))
        .route("/ws/guest", get(guest_ws))
        .route("/ws/ingest", get(ingest_ws))
        .layer(axum::middleware::map_response(security_headers))
        .with_state(state)
}

async fn security_headers(mut response: Response) -> Response {
    let h = response.headers_mut();
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    response
}

// ---------------------------------------------------------------- auth

#[derive(Deserialize, Default)]
struct TokenQuery {
    t: Option<String>,
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

async fn is_host(state: &AppState, headers: &HeaderMap, query: &TokenQuery) -> bool {
    let given = headers
        .get("x-streamfree-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .or_else(|| query.t.clone());
    let expected = state.store.lock().await.settings.host_token.clone();
    given.is_some_and(|g| constant_eq(&g, &expected))
}

macro_rules! require_host {
    ($state:expr, $headers:expr, $query:expr) => {
        if !is_host(&$state, &$headers, &$query).await {
            return (StatusCode::UNAUTHORIZED, "missing or wrong host token").into_response();
        }
    };
}

// ---------------------------------------------------------------- pages

fn embedded(path: &str) -> Response {
    match Web::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref().to_owned()),
                    (header::CACHE_CONTROL, "no-cache".to_owned()),
                ],
                file.data.into_owned(),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn studio_page() -> Response {
    embedded("studio.html")
}

async fn guest_page(State(state): State<Shared>, Path(invite): Path<String>) -> Response {
    let expected = state.store.lock().await.settings.invite_token.clone();
    if !constant_eq(&invite, &expected) {
        return (
            StatusCode::NOT_FOUND,
            "This invite link is not valid any more. Ask the host for a new one.",
        )
            .into_response();
    }
    embedded("guest.html")
}

async fn static_file(Path(path): Path<String>) -> Response {
    if path.contains("..") {
        return (StatusCode::BAD_REQUEST, "bad path").into_response();
    }
    embedded(&path)
}

// ---------------------------------------------------------------- API

async fn info(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    require_host!(state, headers, q);
    let ice = state.store.lock().await.settings.ice_servers.clone();
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "inviteUrl": state.invite_url().await,
        "sharing": crate::sharing::status(&state).await,
        "recordingsDir": state.recordings_dir.display().to_string(),
        "iceServers": ice,
    }))
    .into_response()
}

async fn get_sharing(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    require_host!(state, headers, q);
    Json(crate::sharing::status(&state).await).into_response()
}

#[derive(Deserialize)]
struct SharingInput {
    mode: crate::store::SharingMode,
}

async fn put_sharing(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(input): Json<SharingInput>,
) -> Response {
    require_host!(state, headers, q);
    {
        let mut store = state.store.lock().await;
        store.settings.sharing_mode = input.mode;
        if let Err(e) = store.save() {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response();
        }
    }
    crate::sharing::set_mode(&state, input.mode).await;
    Json(crate::sharing::status(&state).await).into_response()
}

/// QR code of the invite link, so guests can join from a phone.
async fn invite_qr(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    require_host!(state, headers, q);
    let url = state.invite_url().await;
    match qrcode::QrCode::new(url.as_bytes()) {
        Ok(code) => {
            let svg = code
                .render::<qrcode::render::svg::Color>()
                .min_dimensions(240, 240)
                .dark_color(qrcode::render::svg::Color("#1a1530"))
                .light_color(qrcode::render::svg::Color("#ffffff"))
                .build();
            (
                [
                    (header::CONTENT_TYPE, "image/svg+xml"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                svg,
            )
                .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Connects to a destination's server without going live, to catch a wrong
/// server address before the show.
async fn test_destination(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<String>,
) -> Response {
    require_host!(state, headers, q);
    let target = {
        let store = state.store.lock().await;
        let Some(dest) = store.settings.destinations.iter().find(|d| d.id == id) else {
            return (StatusCode::NOT_FOUND, "no such destination").into_response();
        };
        match Target::parse(&dest.url, &dest.key) {
            Ok(t) => t,
            Err(e) => {
                return Json(json!({"ok": false, "message": format!("{e:#}")})).into_response()
            }
        }
    };
    match crate::rtmp::Publisher::check(&target).await {
        Ok(server) => {
            Json(json!({"ok": true, "server": server, "host": target.host})).into_response()
        }
        Err(e) => Json(json!({"ok": false, "message": format!("{e:#}")})).into_response(),
    }
}

async fn list_destinations(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    require_host!(state, headers, q);
    let store = state.store.lock().await;
    let list: Vec<Value> = store
        .settings
        .destinations
        .iter()
        .map(Destination::public)
        .collect();
    Json(list).into_response()
}

#[derive(Deserialize)]
struct DestinationInput {
    id: Option<String>,
    name: String,
    #[serde(default)]
    platform: String,
    url: String,
    /// `None` keeps the stored key.
    key: Option<String>,
    #[serde(default = "default_true")]
    enabled: bool,
}

fn default_true() -> bool {
    true
}

async fn save_destination(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(input): Json<DestinationInput>,
) -> Response {
    require_host!(state, headers, q);
    let mut store = state.store.lock().await;
    let existing_key = input
        .id
        .as_ref()
        .and_then(|id| store.settings.destinations.iter().find(|d| &d.id == id))
        .map(|d| d.key.clone());
    let key = input.key.clone().or(existing_key).unwrap_or_default();
    if let Err(e) = Target::parse(&input.url, &key) {
        return (StatusCode::BAD_REQUEST, format!("{e:#}")).into_response();
    }
    let dest = Destination {
        id: input.id.clone().unwrap_or_else(random_token),
        name: input.name.trim().chars().take(60).collect(),
        platform: input.platform,
        url: input.url.trim().to_owned(),
        key,
        enabled: input.enabled,
    };
    match store
        .settings
        .destinations
        .iter_mut()
        .find(|d| d.id == dest.id)
    {
        Some(slot) => *slot = dest.clone(),
        None => store.settings.destinations.push(dest.clone()),
    }
    if let Err(e) = store.save() {
        return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response();
    }
    Json(dest.public()).into_response()
}

async fn delete_destination(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<String>,
) -> Response {
    require_host!(state, headers, q);
    let mut store = state.store.lock().await;
    store.settings.destinations.retain(|d| d.id != id);
    match store.save() {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

async fn get_studio(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    require_host!(state, headers, q);
    Json(state.store.lock().await.settings.studio.clone()).into_response()
}

async fn put_studio(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(value): Json<Value>,
) -> Response {
    require_host!(state, headers, q);
    let mut store = state.store.lock().await;
    store.settings.studio = value;
    match store.save() {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

async fn put_ice(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(servers): Json<Vec<IceServer>>,
) -> Response {
    require_host!(state, headers, q);
    let mut store = state.store.lock().await;
    store.settings.ice_servers = servers;
    match store.save() {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

async fn reset_invite(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    require_host!(state, headers, q);
    {
        let mut store = state.store.lock().await;
        store.settings.invite_token = random_token();
        if let Err(e) = store.save() {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response();
        }
    }
    Json(json!({ "inviteUrl": state.invite_url().await })).into_response()
}

#[derive(Deserialize)]
struct AssetQuery {
    t: Option<String>,
    name: Option<String>,
}

fn asset_extension(content_type: &str, name: &str) -> Option<&'static str> {
    let by_type = match content_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "audio/mpeg" => Some("mp3"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/ogg" => Some("ogg"),
        _ => None,
    };
    by_type.or_else(|| {
        let ext = name.rsplit('.').next()?.to_ascii_lowercase();
        [
            "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "webm", "mov", "mp3", "wav", "ogg",
        ]
        .into_iter()
        .find(|e| *e == ext)
    })
}

async fn upload_asset(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<AssetQuery>,
    body: Bytes,
) -> Response {
    require_host!(state, headers, TokenQuery { t: q.t.clone() });
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let name = q.name.unwrap_or_default();
    let Some(ext) = asset_extension(content_type, &name) else {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "use PNG, JPEG, GIF, WebP, SVG, MP4, WebM, MOV, MP3, WAV or OGG",
        )
            .into_response();
    };
    let id = format!("{}.{ext}", random_token());
    let dir = state.store.lock().await.assets_dir();
    if let Err(e) = tokio::fs::write(dir.join(&id), &body).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    Json(json!({ "id": id, "name": name, "bytes": body.len() })).into_response()
}

async fn get_asset(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<String>,
) -> Response {
    require_host!(state, headers, q);
    let valid = id.len() < 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
        && !id.starts_with('.');
    if !valid {
        return (StatusCode::BAD_REQUEST, "bad asset id").into_response();
    }
    let path = state.store.lock().await.assets_dir().join(&id);
    match tokio::fs::read(&path).await {
        Ok(data) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref().to_owned())], data).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "no such asset").into_response(),
    }
}

#[derive(Deserialize)]
struct ChannelInput {
    channel: String,
}

async fn start_twitch(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(input): Json<ChannelInput>,
) -> Response {
    require_host!(state, headers, q);
    let Some(channel) = chat::normalize_channel(&input.channel) else {
        return (StatusCode::BAD_REQUEST, "not a valid Twitch channel name").into_response();
    };
    let mut slot = state.chat.lock().await;
    if let Some((_, stop)) = slot.take() {
        let _ = stop.send(true);
    }
    let (stop, stop_rx) = watch::channel(false);
    tokio::spawn(chat::follow_twitch(
        channel.clone(),
        state.events.clone(),
        stop_rx,
    ));
    *slot = Some((channel.clone(), stop));
    Json(json!({ "channel": channel })).into_response()
}

async fn stop_twitch(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    require_host!(state, headers, q);
    if let Some((_, stop)) = state.chat.lock().await.take() {
        let _ = stop.send(true);
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn open_recordings(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    require_host!(state, headers, q);
    let dir = state.recordings_dir.clone();
    let _ = std::fs::create_dir_all(&dir);
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    match std::process::Command::new(program).arg(&dir).spawn() {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ---------------------------------------------------------------- signaling

async fn host_ws(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    require_host!(state, headers, q);
    ws.on_upgrade(move |socket| host_session(state, socket))
}

async fn host_session(state: Shared, socket: WebSocket) {
    state.studio_page_delta(true);
    host_session_inner(&state, socket).await;
    state.studio_page_delta(false);
}

async fn host_session_inner(state: &Shared, mut socket: WebSocket) {
    let (tx, mut rx) = mpsc::channel::<String>(256);
    *state.host_tx.lock().await = Some(tx.clone());
    let mut events = state.events.subscribe();
    let snapshot: Vec<Value> = state
        .guests
        .lock()
        .await
        .iter()
        .map(|(id, g)| json!({"id": id, "name": g.name}))
        .collect();
    let hello = json!({"type": "hello", "guests": snapshot});
    if socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                let Message::Text(text) = msg else { continue };
                let Ok(mut value) = serde_json::from_str::<Value>(&text) else { continue };
                let Some(to) = value.get("to").and_then(Value::as_str).map(str::to_owned) else { continue };
                if value.get("type").and_then(Value::as_str) == Some("kick") {
                    state.guests.lock().await.remove(&to);
                    state.to_host(json!({"type": "guest-left", "id": to})).await;
                    continue;
                }
                value["from"] = "host".into();
                let guests = state.guests.lock().await;
                if let Some(guest) = guests.get(&to) {
                    let _ = guest.tx.try_send(value.to_string());
                }
            }
            outgoing = rx.recv() => {
                let Some(text) = outgoing else { break };
                if socket.send(Message::Text(text.into())).await.is_err() { break }
            }
            event = events.recv() => {
                match event {
                    Ok(value) => {
                        if socket.send(Message::Text(value.to_string().into())).await.is_err() { break }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    let mut slot = state.host_tx.lock().await;
    if slot
        .as_ref()
        .is_some_and(|current| current.same_channel(&tx))
    {
        *slot = None;
    }
}

#[derive(Deserialize)]
struct GuestQuery {
    invite: String,
    #[serde(default)]
    name: String,
}

async fn guest_ws(
    State(state): State<Shared>,
    Query(q): Query<GuestQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let expected = state.store.lock().await.settings.invite_token.clone();
    if !constant_eq(&q.invite, &expected) {
        return (StatusCode::FORBIDDEN, "invalid invite").into_response();
    }
    if state.guests.lock().await.len() >= MAX_GUESTS {
        return (StatusCode::SERVICE_UNAVAILABLE, "the studio is full").into_response();
    }
    let name: String = q
        .name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    let name = if name.is_empty() {
        "Guest".to_owned()
    } else {
        name
    };
    ws.on_upgrade(move |socket| guest_session(state, socket, name))
}

async fn guest_session(state: Shared, mut socket: WebSocket, name: String) {
    let id = random_token()[..12].to_owned();
    let (tx, mut rx) = mpsc::channel::<String>(256);
    state.guests.lock().await.insert(
        id.clone(),
        Guest {
            name: name.clone(),
            tx,
        },
    );
    let ice = state.store.lock().await.settings.ice_servers.clone();
    let welcome = json!({"type": "welcome", "id": id, "iceServers": ice});
    if socket
        .send(Message::Text(welcome.to_string().into()))
        .await
        .is_ok()
    {
        state
            .to_host(json!({"type": "guest-joined", "id": id, "name": name}))
            .await;
        loop {
            tokio::select! {
                incoming = socket.recv() => {
                    let Some(Ok(msg)) = incoming else { break };
                    let Message::Text(text) = msg else { continue };
                    if text.len() > 64 * 1024 { continue }
                    let Ok(mut value) = serde_json::from_str::<Value>(&text) else { continue };
                    value["from"] = id.clone().into();
                    if let Some(obj) = value.as_object_mut() { obj.remove("to"); }
                    state.to_host(value).await;
                }
                outgoing = rx.recv() => {
                    // The host kicked this guest when the sender is dropped.
                    let Some(text) = outgoing else { break };
                    if socket.send(Message::Text(text.into())).await.is_err() { break }
                }
            }
        }
    }
    if state.guests.lock().await.remove(&id).is_some() {
        state.to_host(json!({"type": "guest-left", "id": id})).await;
    }
}

// ---------------------------------------------------------------- media ingest

async fn ingest_ws(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    require_host!(state, headers, q);
    ws.max_message_size(32 * 1024 * 1024)
        .on_upgrade(move |socket| ingest_session(state, socket))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum IngestControl {
    Start {
        record: bool,
        #[serde(default)]
        destinations: Vec<String>,
        #[serde(default)]
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    VideoConfig {
        width: u32,
        height: u32,
        framerate: u32,
        bitrate: u32,
        description: Vec<u8>,
    },
    #[serde(rename_all = "camelCase")]
    AudioConfig {
        sample_rate: u32,
        channels: u32,
        bitrate: u32,
        description: Vec<u8>,
    },
    Stop,
}

/// Binary media message: kind (u8), flags (u8), pts in µs (i64 BE), payload.
pub fn parse_media(data: &[u8]) -> Option<Packet> {
    if data.len() < 10 {
        return None;
    }
    let track = match data[0] {
        2 => Track::Video,
        4 => Track::Audio,
        _ => return None,
    };
    let pts_us = i64::from_be_bytes(data[2..10].try_into().ok()?);
    Some(Packet {
        track,
        pts_us,
        keyframe: data[1] & 1 == 1,
        data: bytes::Bytes::copy_from_slice(&data[10..]),
    })
}

fn safe_file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(80)
        .collect();
    let cleaned = cleaned.trim_matches('-').to_owned();
    if cleaned.is_empty() {
        format!("streamfree-{}", random_token()[..8].to_owned())
    } else {
        cleaned
    }
}

fn unique_path(dir: &std::path::Path, stem: &str) -> PathBuf {
    let mut path = dir.join(format!("{stem}.mp4"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}.mp4"));
        n += 1;
    }
    path
}

async fn send_json(socket: &mut WebSocket, value: Value) -> bool {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .is_ok()
}

async fn ingest_session(state: Shared, mut socket: WebSocket) {
    {
        let mut live = state.live.lock().await;
        if *live {
            let _ = send_json(
                &mut socket,
                json!({"type": "error", "error": "another broadcast is already running"}),
            )
            .await;
            return;
        }
        *live = true;
    }
    run_ingest(&state, &mut socket).await;
    *state.live.lock().await = false;
}

async fn run_ingest(state: &Shared, socket: &mut WebSocket) {
    let mut start: Option<(bool, Vec<String>, String)> = None;
    let mut video: Option<VideoConfig> = None;
    let mut audio: Option<AudioConfig> = None;
    let mut pending: Vec<Packet> = Vec::new();
    let mut session: Option<Session> = None;
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    let started_at = Instant::now();

    let stop_reason = loop {
        tokio::select! {
            incoming = socket.recv() => {
                let msg = match incoming {
                    Some(Ok(msg)) => msg,
                    _ => break "studio disconnected",
                };
                match msg {
                    Message::Binary(data) => {
                        let Some(packet) = parse_media(&data) else { continue };
                        match session.as_mut() {
                            Some(s) => s.push(packet),
                            None if pending.len() < 1000 => pending.push(packet),
                            None => {}
                        }
                    }
                    Message::Text(text) => {
                        let control = match serde_json::from_str::<IngestControl>(&text) {
                            Ok(c) => c,
                            Err(e) => {
                                send_json(socket, json!({"type": "error", "error": format!("bad control message: {e}")})).await;
                                continue;
                            }
                        };
                        match control {
                            IngestControl::Start { record, destinations, name } => start = Some((record, destinations, name)),
                            IngestControl::VideoConfig { width, height, framerate, bitrate, description } => {
                                video = Some(VideoConfig { width, height, framerate, bitrate, avcc: description.into() });
                            }
                            IngestControl::AudioConfig { sample_rate, channels, bitrate, description } => {
                                let Some(asc) = crate::media::audio_specific_config(&description) else {
                                    send_json(socket, json!({"type": "error", "error": "unsupported audio encoder configuration"})).await;
                                    break "could not start";
                                };
                                audio = Some(AudioConfig { sample_rate, channels, bitrate, asc });
                            }
                            IngestControl::Stop => break "stopped by host",
                        }
                        if session.is_none() {
                            if let (Some((record, ids, name)), Some(v), Some(a)) = (&start, &video, &audio) {
                                match build_session(state, *record, ids, name, v.clone(), a.clone()).await {
                                    Ok(mut s) => {
                                        for p in pending.drain(..) { s.push(p); }
                                        session = Some(s);
                                        send_json(socket, json!({"type": "started"})).await;
                                    }
                                    Err(e) => {
                                        send_json(socket, json!({"type": "error", "error": e})).await;
                                        break "could not start";
                                    }
                                }
                            }
                        }
                    }
                    Message::Close(_) => break "studio closed the connection",
                    _ => {}
                }
            }
            _ = ticker.tick() => {
                if let Some(s) = &session {
                    let (outputs, recording) = s.status().await;
                    let ok = send_json(socket, json!({
                        "type": "status",
                        "elapsed": started_at.elapsed().as_secs(),
                        "outputs": outputs,
                        "recording": recording,
                    })).await;
                    if !ok { break "studio disconnected" }
                }
            }
        }
    };
    tracing::info!("broadcast ending: {stop_reason}");
    if let Some(s) = session {
        let (outputs, recording) = s.stop().await;
        send_json(socket, json!({"type": "stopped", "reason": stop_reason, "outputs": outputs, "recording": recording})).await;
    }
    let _ = socket.send(Message::Close(None)).await;
}

async fn build_session(
    state: &Shared,
    record: bool,
    ids: &[String],
    name: &str,
    video: VideoConfig,
    audio: AudioConfig,
) -> Result<Session, String> {
    let store = state.store.lock().await;
    let mut destinations = Vec::new();
    for id in ids {
        let dest = store
            .settings
            .destinations
            .iter()
            .find(|d| &d.id == id)
            .ok_or_else(|| format!("unknown destination {id}"))?;
        let target =
            Target::parse(&dest.url, &dest.key).map_err(|e| format!("{}: {e:#}", dest.name))?;
        destinations.push(DestinationSpec {
            id: dest.id.clone(),
            name: dest.name.clone(),
            target,
        });
    }
    drop(store);
    if destinations.is_empty() && !record {
        return Err("choose at least one destination or turn on recording".into());
    }
    let record_path = record.then(|| unique_path(&state.recordings_dir, &safe_file_stem(name)));
    Ok(Session::start(
        StreamConfig { video, audio },
        SessionOptions {
            destinations,
            record_path,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_media_header() {
        let mut data = vec![2, 1];
        data.extend_from_slice(&123_456i64.to_be_bytes());
        data.extend_from_slice(&[9, 9]);
        let p = parse_media(&data).unwrap();
        assert_eq!(p.track, Track::Video);
        assert!(p.keyframe);
        assert_eq!(p.pts_us, 123_456);
        assert_eq!(&p.data[..], &[9, 9]);
        assert!(parse_media(&[7; 12]).is_none());
        assert!(parse_media(&[2, 0]).is_none());
    }

    #[test]
    fn sanitizes_recording_names() {
        assert_eq!(
            safe_file_stem("My Show 2026/10/12 21:30"),
            "My-Show-2026-10-12-21-30"
        );
        assert!(safe_file_stem("../..").starts_with("streamfree-"));
    }

    #[test]
    fn constant_time_compare() {
        assert!(constant_eq("abc", "abc"));
        assert!(!constant_eq("abc", "abd"));
        assert!(!constant_eq("abc", "ab"));
    }
}
