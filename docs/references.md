# References

Specifications and papers that shaped streamFree's design, with what each one
is used for. Links point to the official or author-hosted versions. Each
reference was checked on 12 October 2026.

## Protocols and formats in use

| Reference | Used for |
|---|---|
| Adobe, *Real-Time Messaging Protocol (RTMP) specification* 1.0, H. Parmar and M. Thornburgh (eds.), December 2012. Originally published at <http://www.adobe.com/devnet/rtmp/> (Adobe has since removed the page; see the [Wikipedia summary](https://en.wikipedia.org/wiki/Real-Time_Messaging_Protocol)) | Handshake, chunk stream, message types, `connect`/`createStream`/`publish` commands (`src/rtmp/`) |
| Adobe, *Action Message Format – AMF 0* and *Video File Format Specification v10.1* (FLV) | AMF0 command encoding and the FLV tag bodies RTMP carries (`src/flv.rs`) |
| Veovera, [*Enhanced RTMP* v1/v2](https://github.com/veovera/enhanced-rtmp) ([v2 document](https://veovera.org/docs/enhanced/enhanced-rtmp-v2)) | Planned: HEVC/AV1/Opus over RTMP and multitrack |
| ISO/IEC 14496-12, *ISO base media file format* (7th edition, 2022); ISO/IEC 14496-14 (MP4); ISO/IEC 14496-15 (AVC in ISO BMFF) | Fragmented MP4 recorder: `moov`/`mvex`, `moof`/`traf`/`trun`, `avcC`, `esds` (`src/mp4.rs`) |
| W3C, [*WebCodecs*](https://www.w3.org/TR/webcodecs/) (Working Draft) | Hardware H.264 and AAC encoding in the studio (`web/js/compositor-worker.js`) |
| W3C, [*MediaStreamTrack Insertable Media Processing using Streams*](https://www.w3.org/TR/mediacapture-transform/) (Working Draft) | `MediaStreamTrackProcessor`/`Generator`: raw frames from cameras, screens and guests into the compositor, and the return feed to guests |
| H. Alvestrand, [RFC 8825](https://www.rfc-editor.org/rfc/rfc8825), *Overview: Real-Time Protocols for Browser-Based Applications*, 2021 | WebRTC architecture for guests |
| J. Uberti, C. Jennings, E. Rescorla (ed.), [RFC 9429](https://www.rfc-editor.org/rfc/rfc9429), *JavaScript Session Establishment Protocol (JSEP)*, April 2024 (obsoletes RFC 8829) | Offer/answer flow and transceiver handling between host and guests |
| [RFC 8445](https://www.rfc-editor.org/rfc/rfc8445) *ICE*; M. Petit-Huguenin et al., [RFC 8489](https://www.rfc-editor.org/rfc/rfc8489) *STUN*, February 2020; [RFC 8656](https://www.rfc-editor.org/rfc/rfc8656) *TURN*, February 2020 | NAT traversal for guests; why a TURN server is sometimes needed |
| M. Westerlund, S. Wenger, [RFC 7667](https://www.rfc-editor.org/rfc/rfc7667), *RTP Topologies*, November 2015 | Choice of a star topology (host as the central mixer) instead of a mesh; the Selective Forwarding Middlebox design for future larger rooms |
| S. Garcia Murillo, A. Gouaillard, [RFC 9725](https://www.rfc-editor.org/rfc/rfc9725), *WebRTC-HTTP Ingestion Protocol (WHIP)*, March 2025 | Planned: WHIP output for sub-second latency ingest |
| Twitch, [Chat & IRC documentation](https://dev.twitch.tv/docs/chat/irc/) | Read-only chat for on-screen comments (`src/chat.rs`). The documented flow needs a user access token; streamFree uses the long-standing but undocumented anonymous `justinfan` login, which Twitch could stop accepting |

## Papers for current and planned features

| Paper | Relevance |
|---|---|
| G. Carlucci, L. De Cicco, S. Holmer, S. Mascolo, *Analysis and Design of the Google Congestion Control for Web Real-time Communication (WebRTC)*, ACM MMSys 2016; extended as *Congestion Control for Web Real-Time Communication*, IEEE/ACM Transactions on Networking 25(5), 2017, [doi:10.1109/TNET.2017.2703615](https://doi.org/10.1109/TNET.2017.2703615). Lab page: <https://c3lab.poliba.it/MultimediaCC> | How the browser adapts guest bitrates; why the return feed is capped so it does not compete with a guest's upload |
| J.-M. Valin, *A Hybrid DSP/Deep Learning Approach to Real-Time Full-Band Speech Enhancement*, MMSP 2018, [arXiv:1709.08243](https://arxiv.org/abs/1709.08243) (RNNoise) | Planned: optional noise suppression that runs locally (WASM), beyond the browser's built-in one |
| H. Schröter, A. N. Escalante-B., T. Rosenkranz, A. Maier, *DeepFilterNet: A Low Complexity Speech Enhancement Framework for Full-Band Audio based on Deep Filtering*, ICASSP 2022, [arXiv:2110.05588](https://arxiv.org/abs/2110.05588) | Planned: higher-quality local noise suppression |
| C. Lugaresi et al., *MediaPipe: A Framework for Building Perception Pipelines*, 2019, [arXiv:1906.08172](https://arxiv.org/abs/1906.08172) | Planned: in-browser person segmentation for background blur and replacement |
| S. Lin, L. Yang, I. Saleemi, S. Sengupta, *Robust High-Resolution Video Matting with Temporal Guidance*, WACV 2022, [arXiv:2108.11515](https://arxiv.org/abs/2108.11515) | Planned: higher-quality background replacement without a green screen |
| A. Radford, J. W. Kim, T. Xu, G. Brockman, C. McLeavey, I. Sutskever, *Robust Speech Recognition via Large-Scale Weak Supervision*, 2022, [arXiv:2212.04356](https://arxiv.org/abs/2212.04356) (Whisper) | Planned: local live captions and transcripts |

Third-party papers and specifications are linked, not copied into this
repository, because most are not licensed for redistribution.
