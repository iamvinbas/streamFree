use futures_util::{future::join_all, SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::Duration;
use streamfree::server::{self, AppState, Shared};
use streamfree::store::Store;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Error as WebSocketError, Message},
    MaybeTlsStream, WebSocketStream,
};

const TEST_TIMEOUT: Duration = Duration::from_secs(10);
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Studio {
    _dir: tempfile::TempDir,
    server: JoinHandle<()>,
    addr: SocketAddr,
    state: Shared,
    token: String,
    invite: String,
}

impl Studio {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_owned()).unwrap();
        let token = store.settings.host_token.clone();
        let invite = store.settings.invite_token.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let state = AppState::new(
            store,
            dir.path().join("videos"),
            dir.path().into(),
            addr.port(),
        );
        let app = server::router(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            _dir: dir,
            server,
            addr,
            state,
            token,
            invite,
        }
    }

    async fn connect(&self, path: &str) -> Socket {
        self.try_connect(path).await.unwrap()
    }

    async fn try_connect(&self, path: &str) -> Result<Socket, WebSocketError> {
        timeout(
            TEST_TIMEOUT,
            connect_async(format!("ws://{}{path}", self.addr)),
        )
        .await
        .unwrap()
        .map(|(socket, _)| socket)
    }

    async fn guest(&self) -> (Socket, Value) {
        let mut guest = self
            .connect(&format!("/ws/guest?invite={}", self.invite))
            .await;
        let welcome = receive_json(&mut guest).await;
        assert_eq!(welcome["type"], "welcome");
        (guest, welcome)
    }

    async fn send_http(&self, request: &[u8]) -> String {
        let mut stream = TcpStream::connect(self.addr).await.unwrap();
        stream.write_all(request).await.unwrap();
        let mut response = String::new();
        timeout(TEST_TIMEOUT, stream.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        response
    }

    async fn wait_for_live(&self, expected: bool) {
        timeout(TEST_TIMEOUT, async {
            while self.state.is_live().await != expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}

impl Drop for Studio {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn send_text(socket: &mut Socket, text: &str) {
    timeout(
        TEST_TIMEOUT,
        socket.send(Message::Text(text.to_owned().into())),
    )
    .await
    .unwrap()
    .unwrap();
}

async fn receive_json(socket: &mut Socket) -> Value {
    let msg = timeout(TEST_TIMEOUT, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(msg.to_text().unwrap()).unwrap()
}

#[tokio::test]
async fn guest_signaling_filters_server_events_and_uses_server_identity() {
    let studio = Studio::start().await;
    let mut host = studio
        .connect(&format!("/ws/host?t={}", studio.token))
        .await;
    assert_eq!(receive_json(&mut host).await["type"], "hello");
    let (mut guest, welcome) = studio.guest().await;
    let id = &welcome["id"];
    assert_eq!(receive_json(&mut host).await["id"], *id);

    for invalid in [
        r#"{"type":"guest-left","id":"another-guest"}"#,
        r#"{"type":"sharing","inviteUrl":"https://example.invalid"}"#,
        r#"{"type":"hello","guests":[]}"#,
        r#"{"type":"guest-joined","id":"spoof"}"#,
        r#"{"type":"chat-status","state":"connected"}"#,
        "[]",
        "true",
        r#"{"type":"chat","text":{"unexpected":true}}"#,
    ] {
        send_text(&mut guest, invalid).await;
    }
    send_text(
        &mut guest,
        r#"{"type":"chat","text":"hi","platform":"twitch","author":"fake","from":"fake","to":"fake"}"#,
    ).await;
    assert_eq!(
        receive_json(&mut host).await,
        json!({"type":"chat","text":"hi","from":id})
    );

    for allowed in [
        json!({"type":"answer","sdp":"v=0"}),
        json!({"type":"candidate","candidate":{"candidate":"candidate:1","sdpMid":null,"sdpMLineIndex":0}}),
        json!({"type":"state","micOn":false}),
        json!({"type":"relay-ready","caps":{"h264":true,"opus":false}}),
    ] {
        send_text(&mut guest, &allowed.to_string()).await;
        let mut expected = allowed;
        expected["from"] = id.clone();
        assert_eq!(receive_json(&mut host).await, expected);
    }
}

#[tokio::test]
async fn guest_relay_ignores_invalid_control_without_losing_the_connection() {
    let studio = Studio::start().await;
    let (_guest, welcome) = studio.guest().await;
    let id = welcome["id"].as_str().unwrap();
    let key = welcome["relayKey"].as_str().unwrap();
    let mut host = studio
        .connect(&format!("/ws/relay/host?t={}", studio.token))
        .await;
    let mut guest = studio
        .connect(&format!(
            "/ws/relay/guest?invite={}&id={id}&key={key}",
            studio.invite
        ))
        .await;
    assert_eq!(
        receive_json(&mut host).await,
        json!({"type":"relay-open","from":id})
    );

    send_text(&mut guest, r#"{"type":"relay-closed","from":"fake"}"#).await;
    send_text(&mut guest, "[]").await;
    send_text(&mut guest, r#"{"type":"key","from":"fake"}"#).await;
    assert_eq!(
        receive_json(&mut host).await,
        json!({"type":"key","from":id})
    );
}

#[tokio::test]
async fn simultaneous_upgrades_respect_the_guest_limit_and_release_slots() {
    let studio = Studio::start().await;
    let path = format!("/ws/guest?invite={}", studio.invite);
    let attempts = join_all((0..64).map(|_| studio.try_connect(&path))).await;
    let mut admitted = Vec::new();
    for attempt in attempts {
        match attempt {
            Ok(socket) => admitted.push(socket),
            Err(WebSocketError::Http(response)) => assert_eq!(response.status(), 503),
            Err(error) => panic!("unexpected guest upgrade failure: {error}"),
        }
    }
    assert_eq!(admitted.len(), 16);
    for socket in &mut admitted {
        assert_eq!(receive_json(socket).await["type"], "welcome");
    }

    let mut departing = admitted.pop().unwrap();
    departing.close(None).await.unwrap();
    drop(departing);
    let mut replacement = timeout(TEST_TIMEOUT, async {
        loop {
            match studio.try_connect(&path).await {
                Ok(socket) => break socket,
                Err(WebSocketError::Http(response)) if response.status() == 503 => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("unexpected upgrade failure after a guest left: {error}"),
            }
        }
    })
    .await
    .expect("a departing guest must release the slot");
    assert_eq!(receive_json(&mut replacement).await["type"], "welcome");
}

#[tokio::test]
async fn concurrent_relay_upgrades_admit_only_one_and_allow_reconnection() {
    let studio = Studio::start().await;
    let (_guest, welcome) = studio.guest().await;
    let id = welcome["id"].as_str().unwrap();
    let key = welcome["relayKey"].as_str().unwrap();
    let path = format!("/ws/relay/guest?invite={}&id={id}&key={key}", studio.invite);
    let mut host = studio
        .connect(&format!("/ws/relay/host?t={}", studio.token))
        .await;
    let attempts = join_all((0..8).map(|_| studio.try_connect(&path))).await;
    let mut admitted = Vec::new();
    for attempt in attempts {
        match attempt {
            Ok(socket) => admitted.push(socket),
            Err(WebSocketError::Http(response)) => assert_eq!(response.status(), 409),
            Err(error) => panic!("unexpected relay upgrade failure: {error}"),
        }
    }
    assert_eq!(admitted.len(), 1);
    let mut relay = admitted.pop().unwrap();
    assert_eq!(
        receive_json(&mut host).await,
        json!({"type":"relay-open","from":id})
    );

    send_text(&mut relay, r#"{"type":"key"}"#).await;
    assert_eq!(
        receive_json(&mut host).await,
        json!({"type":"key","from":id})
    );
    send_text(
        &mut host,
        &json!({"type":"relay-config","to":id,"video":"h264"}).to_string(),
    )
    .await;
    assert_eq!(
        receive_json(&mut relay).await,
        json!({"type":"relay-config","video":"h264"})
    );

    relay.close(None).await.unwrap();
    assert_eq!(
        receive_json(&mut host).await,
        json!({"type":"relay-closed","from":id})
    );
    let _reconnected = studio.connect(&path).await;
    assert_eq!(
        receive_json(&mut host).await,
        json!({"type":"relay-open","from":id})
    );
}

#[tokio::test]
async fn removing_a_guest_revokes_the_active_relay_and_its_credentials() {
    let studio = Studio::start().await;
    let mut host_signal = studio
        .connect(&format!("/ws/host?t={}", studio.token))
        .await;
    assert_eq!(receive_json(&mut host_signal).await["type"], "hello");
    let (_guest, welcome) = studio.guest().await;
    let id = welcome["id"].as_str().unwrap();
    let key = welcome["relayKey"].as_str().unwrap();
    assert_eq!(receive_json(&mut host_signal).await["id"], id);
    let path = format!("/ws/relay/guest?invite={}&id={id}&key={key}", studio.invite);
    let mut host_relay = studio
        .connect(&format!("/ws/relay/host?t={}", studio.token))
        .await;
    let mut relay = studio.connect(&path).await;
    assert_eq!(
        receive_json(&mut host_relay).await,
        json!({"type":"relay-open","from":id})
    );

    send_text(
        &mut host_signal,
        &json!({"type":"kick","to":id}).to_string(),
    )
    .await;
    assert_eq!(
        receive_json(&mut host_relay).await,
        json!({"type":"relay-closed","from":id})
    );
    let next = timeout(TEST_TIMEOUT, relay.next())
        .await
        .expect("removing a guest must close their relay");
    assert!(matches!(next, None | Some(Err(_) | Ok(Message::Close(_)))));
    match studio.try_connect(&path).await {
        Err(WebSocketError::Http(response)) => assert_eq!(response.status(), 403),
        other => panic!("the removed guest's relay credentials were accepted: {other:?}"),
    }
}

#[tokio::test]
async fn asset_upload_checks_the_token_before_reading_the_body() {
    let studio = Studio::start().await;
    // Advertise 4096 bytes and leave the request incomplete. A handler that
    // extracts the body before authentication would wait for the rest.
    let unauthorized = studio.send_http(
        b"POST /api/assets?name=image.png HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: image/png\r\nContent-Length: 4096\r\n\r\nx",
    ).await;
    assert!(unauthorized.starts_with("HTTP/1.1 401 "));

    for (query, header) in [
        (format!("&t={}", studio.token), String::new()),
        (
            String::new(),
            format!("x-streamfree-token: {}\r\n", studio.token),
        ),
    ] {
        let request = format!(
            "POST /api/assets?name=image.png{query} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: image/png\r\n{header}Content-Length: 3\r\n\r\nabc"
        );
        let response = studio.send_http(request.as_bytes()).await;
        assert!(response.starts_with("HTTP/1.1 200 "));
    }
}

#[tokio::test]
async fn ingest_releases_the_slot_after_the_pending_byte_limit() {
    let studio = Studio::start().await;
    let mut socket = studio
        .connect(&format!("/ws/ingest?t={}", studio.token))
        .await;
    // Each message fits the WebSocket limits. Their combined payload exceeds
    // the pre-configuration budget, even though there are only two packets.
    for payload_size in [8 * 1024 * 1024, 8 * 1024 * 1024 + 1] {
        let mut packet = vec![0; payload_size + 10];
        packet[0] = 2;
        timeout(TEST_TIMEOUT, socket.send(Message::Binary(packet.into())))
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(
        receive_json(&mut socket).await["error"],
        "too much media before broadcast configuration"
    );
    studio.wait_for_live(false).await;
}

#[tokio::test]
async fn ingest_releases_the_slot_if_configuration_never_arrives() {
    let studio = Studio::start().await;
    let mut socket = studio
        .connect(&format!("/ws/ingest?t={}", studio.token))
        .await;
    studio.wait_for_live(true).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(31)).await;
    tokio::time::resume();
    assert_eq!(
        receive_json(&mut socket).await["error"],
        "timed out waiting for broadcast configuration"
    );
    studio.wait_for_live(false).await;
}
