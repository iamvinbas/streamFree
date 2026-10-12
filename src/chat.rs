//! Read-only Twitch chat over IRC (anonymous `justinfan` login, no account or
//! API key needed). Messages are forwarded to the studio so the host can put
//! them on screen.

use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, watch};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChatMessage {
    pub id: String,
    pub platform: &'static str,
    pub channel: String,
    pub author: String,
    pub color: Option<String>,
    pub text: String,
}

/// Parses one IRC line with IRCv3 tags; returns a chat message for PRIVMSG.
pub fn parse_privmsg(line: &str) -> Option<ChatMessage> {
    let mut rest = line;
    let mut tags = HashMap::new();
    if let Some(stripped) = rest.strip_prefix('@') {
        let (raw, after) = stripped.split_once(' ')?;
        for pair in raw.split(';') {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            tags.insert(k, unescape_tag(v));
        }
        rest = after;
    }
    let rest = rest.strip_prefix(':')?;
    let (prefix, rest) = rest.split_once(' ')?;
    let rest = rest.strip_prefix("PRIVMSG ")?;
    let (channel, text) = rest.split_once(" :")?;
    let nick = prefix.split('!').next().unwrap_or(prefix);
    let author = tags
        .get("display-name")
        .filter(|n| !n.is_empty())
        .cloned()
        .unwrap_or_else(|| nick.to_owned());
    // "/me" actions arrive wrapped in CTCP ACTION markers.
    let text = text
        .strip_prefix("\u{1}ACTION ")
        .and_then(|t| t.strip_suffix('\u{1}'))
        .unwrap_or(text);
    Some(ChatMessage {
        id: tags.get("id").cloned().unwrap_or_default(),
        platform: "twitch",
        channel: channel.trim_start_matches('#').to_owned(),
        author,
        color: tags.get("color").filter(|c| !c.is_empty()).cloned(),
        text: text.to_owned(),
    })
}

fn unescape_tag(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(':') => out.push(';'),
            Some('s') => out.push(' '),
            Some('\\') => out.push('\\'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

pub fn normalize_channel(input: &str) -> Option<String> {
    let name = input
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("www.")
        .trim_start_matches("twitch.tv/")
        .trim_start_matches('#')
        .trim_end_matches('/')
        .to_ascii_lowercase();
    let valid = !name.is_empty()
        && name.len() <= 25
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    valid.then_some(name)
}

/// Follows a channel until `stop` flips, reconnecting with backoff.
pub async fn follow_twitch(
    channel: String,
    tx: broadcast::Sender<serde_json::Value>,
    mut stop: watch::Receiver<bool>,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let session = tokio::select! {
            r = twitch_session(&channel, &tx) => r,
            _ = stop.changed() => return,
        };
        let status = match session {
            Ok(()) => "disconnected".to_string(),
            Err(e) => format!("{e:#}"),
        };
        let _ = tx.send(serde_json::json!({"type": "chat-status", "platform": "twitch", "state": "reconnecting", "error": status}));
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = stop.changed() => return,
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn twitch_session(channel: &str, tx: &broadcast::Sender<serde_json::Value>) -> Result<()> {
    let tcp = TcpStream::connect(("irc.chat.twitch.tv", 6697))
        .await
        .context("connect to Twitch chat")?;
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from("irc.chat.twitch.tv")?;
    let stream = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await?;
    let (read, mut write) = tokio::io::split(stream);
    let mut n = [0u8; 2];
    getrandom::fill(&mut n).ok();
    let nick = format!(
        "justinfan{}",
        10_000 + u16::from_be_bytes(n) as u32 % 80_000
    );
    write
        .write_all(
            format!(
                "CAP REQ :twitch.tv/tags\r\nPASS SCHMOOPIIE\r\nNICK {nick}\r\nJOIN #{channel}\r\n"
            )
            .as_bytes(),
        )
        .await?;
    let mut lines = BufReader::new(read).lines();
    while let Some(line) = tokio::time::timeout(Duration::from_secs(360), lines.next_line())
        .await
        .context("no data from Twitch for 6 minutes")??
    {
        if let Some(payload) = line.strip_prefix("PING") {
            write
                .write_all(format!("PONG{payload}\r\n").as_bytes())
                .await?;
        } else if line.contains(" 366 ") {
            let _ = tx.send(serde_json::json!({"type": "chat-status", "platform": "twitch", "state": "connected", "channel": channel}));
        } else if let Some(msg) = parse_privmsg(&line) {
            let mut value = serde_json::to_value(&msg)?;
            value["type"] = "chat".into();
            let _ = tx.send(value);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tagged_privmsg() {
        let line = "@badge-info=;color=#1E90FF;display-name=Ada\\sL;id=abc-1;mod=0 :ada!ada@ada.tmi.twitch.tv PRIVMSG #somechan :hello world";
        let m = parse_privmsg(line).unwrap();
        assert_eq!(m.author, "Ada L");
        assert_eq!(m.color.as_deref(), Some("#1E90FF"));
        assert_eq!(m.channel, "somechan");
        assert_eq!(m.text, "hello world");
        assert_eq!(m.id, "abc-1");
    }

    #[test]
    fn parses_action_and_untagged() {
        let m =
            parse_privmsg(":bob!bob@bob.tmi.twitch.tv PRIVMSG #c :\u{1}ACTION waves\u{1}").unwrap();
        assert_eq!(m.author, "bob");
        assert_eq!(m.text, "waves");
        assert!(parse_privmsg(":tmi.twitch.tv 001 justinfan1 :Welcome").is_none());
    }

    #[test]
    fn normalizes_channels() {
        assert_eq!(
            normalize_channel("https://www.twitch.tv/SomeOne/").as_deref(),
            Some("someone")
        );
        assert_eq!(normalize_channel("#abc_1").as_deref(), Some("abc_1"));
        assert_eq!(normalize_channel("bad name"), None);
    }
}
