//! Tries to publish to real ingest servers with an invalid stream key and
//! prints how far each one gets. Used to check protocol compatibility and the
//! error users see for a wrong key.
//!
//!   cargo run --example ingest_probe

use streamfree::rtmp::{Publisher, Target};

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let servers = [
        ("YouTube", "rtmp://a.rtmp.youtube.com/live2"),
        ("Twitch", "rtmp://live.twitch.tv/app"),
        ("Facebook", "rtmps://live-api-s.facebook.com:443/rtmp/"),
    ];
    for (name, url) in servers {
        let target = Target::parse(url, "streamfree-probe-not-a-real-key").unwrap();
        match Publisher::connect(&target).await {
            Ok(p) => {
                println!("{name}: publish accepted (the server checks the key later)");
                p.close().await;
            }
            Err(e) => println!("{name}: {e:#}"),
        }
    }
}
