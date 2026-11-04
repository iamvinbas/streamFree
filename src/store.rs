//! Settings persisted on disk: destinations (with stream keys), access tokens,
//! ICE servers and the studio's own state (branding, banners, scenes).
//!
//! The file holds secrets, so it is written atomically with mode 0600.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Destination {
    pub id: String,
    pub name: String,
    /// Free-form platform hint for the UI ("youtube", "twitch", "custom", ...).
    #[serde(default)]
    pub platform: String,
    pub url: String,
    #[serde(default)]
    pub key: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

impl Destination {
    /// The destination as the studio sees it: the key is never sent back,
    /// only whether one is set and its last characters.
    pub fn public(&self) -> serde_json::Value {
        let tail: String = self
            .key
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "platform": self.platform,
            "url": self.url,
            "hasKey": !self.key.is_empty(),
            "keyHint": if self.key.len() > 8 { format!("…{tail}") } else { String::new() },
            "enabled": self.enabled,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IceServer {
    pub urls: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// Who can open the invite link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SharingMode {
    /// Only this computer (http://localhost).
    #[default]
    Local,
    /// Devices on the same network, over HTTPS with a self-signed certificate.
    Lan,
    /// Anyone with the link, through a Cloudflare quick tunnel.
    Internet,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub host_token: String,
    pub invite_token: String,
    #[serde(default)]
    pub destinations: Vec<Destination>,
    #[serde(default = "default_ice")]
    pub ice_servers: Vec<IceServer>,
    #[serde(default)]
    pub sharing_mode: SharingMode,
    /// Opaque studio state owned by the web UI.
    #[serde(default)]
    pub studio: serde_json::Value,
}

fn stun(urls: &str) -> IceServer {
    IceServer {
        urls: urls.into(),
        username: None,
        credential: None,
    }
}

/// Two independent public STUN services, so one being blocked or down does
/// not stop guests from finding a direct path.
fn default_ice() -> Vec<IceServer> {
    vec![
        stun("stun:stun.l.google.com:19302"),
        stun("stun:stun.cloudflare.com:3478"),
    ]
}

/// Settings saved by older versions hold only the first STUN server; give
/// them the current defaults. A list the user edited is left alone.
fn upgrade_ice(servers: &mut Vec<IceServer>) -> bool {
    if *servers == [stun("stun:stun.l.google.com:19302")] {
        *servers = default_ice();
        return true;
    }
    false
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 18];
    getrandom::fill(&mut bytes).expect("OS random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            host_token: random_token(),
            invite_token: random_token(),
            destinations: Vec::new(),
            ice_servers: default_ice(),
            sharing_mode: SharingMode::Local,
            studio: serde_json::Value::Null,
        }
    }
}

pub struct Store {
    pub dir: PathBuf,
    pub settings: Settings,
}

impl Store {
    pub fn open(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(dir.join("assets"))
            .with_context(|| format!("create {}", dir.display()))?;
        let path = dir.join("settings.json");
        let settings = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("parse {}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
        };
        let mut store = Self { dir, settings };
        upgrade_ice(&mut store.settings.ice_servers);
        store.save()?;
        Ok(store)
    }

    pub fn assets_dir(&self) -> PathBuf {
        self.dir.join("assets")
    }

    pub fn save(&self) -> Result<()> {
        let path = self.dir.join("settings.json");
        let tmp = self.dir.join("settings.json.tmp");
        let data = serde_json::to_vec_pretty(&self.settings)?;
        write_private(&tmp, &data)?;
        std::fs::rename(&tmp, &path).with_context(|| format!("write {}", path.display()))?;
        Ok(())
    }
}

fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("open {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(data)?;
    file.sync_all()?;
    Ok(())
}

pub fn default_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("streamFree")
}

pub fn default_recordings_dir() -> PathBuf {
    dirs::video_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("streamFree")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().to_path_buf()).unwrap();
        store.settings.destinations.push(Destination {
            id: "a".into(),
            name: "YouTube".into(),
            platform: "youtube".into(),
            url: "rtmp://a.rtmp.youtube.com/live2".into(),
            key: "secret-key-123456".into(),
            enabled: true,
        });
        store.save().unwrap();
        let again = Store::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(again.settings.destinations, store.settings.destinations);
        assert_eq!(again.settings.host_token, store.settings.host_token);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("settings.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn old_default_ice_list_is_upgraded() {
        let mut old = vec![stun("stun:stun.l.google.com:19302")];
        assert!(upgrade_ice(&mut old));
        assert_eq!(old, default_ice());
        let mut custom = vec![stun("stun:example.org:3478")];
        assert!(!upgrade_ice(&mut custom));
        assert_eq!(custom.len(), 1);
    }

    #[test]
    fn public_view_hides_key() {
        let d = Destination {
            id: "a".into(),
            name: "n".into(),
            platform: String::new(),
            url: "rtmp://x/live".into(),
            key: "abcdefghijkl".into(),
            enabled: true,
        };
        let v = d.public();
        assert!(!v.to_string().contains("abcdefgh"));
        assert_eq!(v["keyHint"], "…ijkl");
    }
}
