//! streamFree core: media containers, RTMP publishing, live sessions and the
//! studio server. The `streamfree` binary wires these together.

pub mod app;
pub mod chat;
#[cfg(any(target_os = "macos", windows))]
pub mod desktop;
pub mod flv;
pub mod live;
pub mod media;
pub mod mp4;
pub mod net;
pub mod rtmp;
pub mod server;
pub mod sharing;
pub mod store;
