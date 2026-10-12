# Feature specification (clean room)

streamFree was designed from the **publicly documented features** of hosted
browser studios, StreamYard in particular, without using any of their code,
assets, network protocols or private behaviour. The studio and its internals
sit behind a login and run largely on the vendor's servers; nothing behind the
login was accessed.

What was looked at (12 October 2026):

- the public pricing page, which lists the features of each plan:
  <https://streamyard.com/pricing>;
- public marketing and blog pages describing features, for example
  <https://streamyard.com/blog/best-streaming-software-for-multi-guest-interviews>,
  <https://streamyard.com/blog/streaming-software-with-overlays-comparison>,
  <https://streamyard.com/blog/easy-to-use-multistreaming-software>;
- the product updates page <https://new.streamyard.com/>;
- a logged-out load of the public home page, which only showed a Next.js
  marketing site with analytics and payment scripts (no studio code).

Everything below is described in our own words and implemented independently.
"StreamYard" is a trademark of its owner; streamFree is not affiliated with it.

## Feature map

Status: ✅ done and tested · 🟡 partial · ⏳ planned.

| Area | Publicly documented capability | streamFree | Notes |
|---|---|---|---|
| Studio | Studio runs in the browser, nothing to install for guests | ✅ | Host installs a small desktop app (own window on macOS/Windows, Chrome/Edge/Brave window on Linux); guests use any modern browser |
| Guests | Guests join from a link | ✅ | Invite link with a revocable token, QR code and share buttons; this computer, local network (HTTPS) or internet (Cloudflare tunnel), chosen in the app; WebRTC; tested end to end |
| Guests | Up to 10 people on screen, 15 backstage (paid plans) | ✅ | Up to 16 guests; no artificial limit on stage size besides layout readability |
| Guests | Backstage / green room | ✅ | Guests wait backstage until the host adds them; private backstage chat |
| Audio | Guests hear the show without echo | ✅ | Per-guest mix-minus return audio |
| Multistreaming | Stream to several destinations at once (3–8 by plan) | ✅ | Unlimited RTMP/RTMPS destinations; each reconnects on its own and a slow one never stalls the others |
| Destinations | YouTube, Facebook, LinkedIn, X, Twitch, Kick, custom RTMP | ✅ | Presets and step-by-step key guides; a Test button checks the server. YouTube, Twitch, Facebook and Kick ingest servers accept our connection (checked with a dummy key); a real broadcast is not yet verified |
| Recording | Cloud recording of the live stream | ✅ | Local recording instead: fragmented MP4 (H.264 + AAC), crash-safe |
| Recording | Local per-participant (multi-track) recordings, up to 4K | ⏳ | Planned: each participant records locally and uploads to the host |
| Quality | Full HD 1080p, 4K local recordings | 🟡 | 720p and 1080p at 30/60 fps; 4K not yet offered |
| Layouts | Preset layouts: solo, split, grid, screen share layouts; custom layouts | 🟡 | 7 presets (solo, grid, side by side, leader, picture in picture, presentation, cinema); custom drag-and-drop layouts planned |
| Branding | Logo, overlays, backgrounds, brand colours, custom fonts | ✅ | Logo, overlays, backgrounds, colours; 5 font styles, name-tag shape and position, banner looks and position, ticker colours, tile spacing |
| Banners | Lower-third banners prepared in advance; scrolling ticker | ✅ | Unlimited banners, one-click show/hide, ticker with speed control |
| Comments | Show viewer comments on screen | 🟡 | Twitch chat (no login needed) and manual comments; YouTube/Facebook chat planned |
| Media | Intro/outro and video clips | ✅ | Upload clips and play them full screen with sound |
| Screen share | Share a screen or window with its audio | ✅ | Screen audio mixed into the program |
| Scenes | Scenes bundling layout, overlays, banners | ⏳ | Planned |
| Vertical | Simultaneous landscape and vertical output | ⏳ | Planned (second canvas and encoder) |
| AI | AI clips, AI backgrounds, transcripts | ⏳ | Planned locally: background blur/replacement, captions with a local speech model |
| Webinars | Hosted viewer page for webinars | ⏳ | Out of scope for a local app for now |
| Interface | Dark mode | ✅ | Light, dark or automatic theme, accent colour, Italian or English, text size, density, side panel position |
| Pricing | Free plan with watermark and limits; paid plans | ✅ | Free and open source (MIT), no watermark, no time limits |

## What "local" means here

- Encoding happens in the host's browser with WebCodecs (hardware encoders
  where available); muxing, recording and RTMP publishing happen in the
  streamFree process. No streamFree server exists anywhere else.
- Guests connect over WebRTC directly to the host's browser. When they are
  not on the same network the host exposes the guest page through HTTPS
  (Cloudflare quick tunnel, their own reverse proxy, or LAN with a
  self-signed certificate). A TURN server may be needed for strict NATs.
