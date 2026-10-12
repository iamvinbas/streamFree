//! FLV tag bodies and AMF0 values (Adobe "Video File Format Specification v10.1",
//! "Action Message Format -- AMF 0").
//!
//! RTMP audio/video/data messages carry FLV tag *bodies*.

use crate::media::{AudioConfig, StreamConfig, VideoConfig};
use bytes::{BufMut, Bytes, BytesMut};

const CODEC_AVC: u8 = 7;
const FRAME_KEY: u8 = 1;
const FRAME_INTER: u8 = 2;
const AVC_SEQUENCE_HEADER: u8 = 0;
const AVC_NALU: u8 = 1;
/// SoundFormat 10 (AAC), SoundRate 3 (44 kHz, always set for AAC),
/// SoundSize 1 (16-bit), SoundType 1 (stereo, always set for AAC).
const AAC_HEADER: u8 = 0xAF;
const AAC_SEQUENCE_HEADER: u8 = 0;
const AAC_RAW: u8 = 1;

/// An AMF0 value. Only the types RTMP publishing needs are modelled.
#[derive(Debug, Clone, PartialEq)]
pub enum Amf {
    Number(f64),
    Bool(bool),
    String(String),
    Object(Vec<(String, Amf)>),
    Null,
    Undefined,
    EcmaArray(Vec<(String, Amf)>),
}

impl Amf {
    pub fn str(s: &str) -> Self {
        Amf::String(s.to_owned())
    }

    pub fn encode(&self, out: &mut BytesMut) {
        match self {
            Amf::Number(n) => {
                out.put_u8(0x00);
                out.put_f64(*n);
            }
            Amf::Bool(b) => {
                out.put_u8(0x01);
                out.put_u8(*b as u8);
            }
            Amf::String(s) => {
                if s.len() > u16::MAX as usize {
                    out.put_u8(0x0C);
                    out.put_u32(s.len() as u32);
                } else {
                    out.put_u8(0x02);
                    out.put_u16(s.len() as u16);
                }
                out.put_slice(s.as_bytes());
            }
            Amf::Object(props) => {
                out.put_u8(0x03);
                encode_props(props, out);
            }
            Amf::Null => out.put_u8(0x05),
            Amf::Undefined => out.put_u8(0x06),
            Amf::EcmaArray(props) => {
                out.put_u8(0x08);
                out.put_u32(props.len() as u32);
                encode_props(props, out);
            }
        }
    }

    /// Decodes one value; returns the value and the bytes consumed.
    pub fn decode(buf: &[u8]) -> Option<(Amf, usize)> {
        let (&marker, rest) = buf.split_first()?;
        match marker {
            0x00 => {
                let bytes: [u8; 8] = rest.get(..8)?.try_into().ok()?;
                Some((Amf::Number(f64::from_be_bytes(bytes)), 9))
            }
            0x01 => Some((Amf::Bool(*rest.first()? != 0), 2)),
            0x02 => {
                let (s, used) = decode_short_string(rest)?;
                Some((Amf::String(s), 1 + used))
            }
            0x0C => {
                let len = u32::from_be_bytes(rest.get(..4)?.try_into().ok()?) as usize;
                let s = String::from_utf8_lossy(rest.get(4..4 + len)?).into_owned();
                Some((Amf::String(s), 5 + len))
            }
            0x03 => {
                let (props, used) = decode_props(rest)?;
                Some((Amf::Object(props), 1 + used))
            }
            0x05 => Some((Amf::Null, 1)),
            0x06 => Some((Amf::Undefined, 1)),
            0x08 => {
                rest.get(..4)?;
                let (props, used) = decode_props(&rest[4..])?;
                Some((Amf::EcmaArray(props), 5 + used))
            }
            _ => None,
        }
    }

    /// Decodes a sequence of values until the buffer ends or an unknown type appears.
    pub fn decode_all(mut buf: &[u8]) -> Vec<Amf> {
        let mut values = Vec::new();
        while !buf.is_empty() {
            match Amf::decode(buf) {
                Some((value, used)) => {
                    values.push(value);
                    buf = &buf[used..];
                }
                None => break,
            }
        }
        values
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Amf::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Amf::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Amf> {
        match self {
            Amf::Object(props) | Amf::EcmaArray(props) => {
                props.iter().find(|(k, _)| k == key).map(|(_, v)| v)
            }
            _ => None,
        }
    }
}

fn encode_props(props: &[(String, Amf)], out: &mut BytesMut) {
    for (key, value) in props {
        out.put_u16(key.len() as u16);
        out.put_slice(key.as_bytes());
        value.encode(out);
    }
    out.put_slice(&[0x00, 0x00, 0x09]);
}

fn decode_short_string(buf: &[u8]) -> Option<(String, usize)> {
    let len = u16::from_be_bytes(buf.get(..2)?.try_into().ok()?) as usize;
    let s = String::from_utf8_lossy(buf.get(2..2 + len)?).into_owned();
    Some((s, 2 + len))
}

fn decode_props(buf: &[u8]) -> Option<(Vec<(String, Amf)>, usize)> {
    let mut props = Vec::new();
    let mut pos = 0;
    loop {
        if buf.get(pos..pos + 3)? == [0x00, 0x00, 0x09] {
            return Some((props, pos + 3));
        }
        let (key, used) = decode_short_string(&buf[pos..])?;
        pos += used;
        let (value, used) = Amf::decode(&buf[pos..])?;
        pos += used;
        props.push((key, value));
    }
}

pub fn encode_values(values: &[Amf]) -> Bytes {
    let mut out = BytesMut::new();
    for value in values {
        value.encode(&mut out);
    }
    out.freeze()
}

/// `onMetaData` script body, preceded by `@setDataFrame` when sent over RTMP.
pub fn metadata(config: &StreamConfig, for_rtmp: bool) -> Bytes {
    let VideoConfig {
        width,
        height,
        framerate,
        bitrate: vbr,
        ..
    } = config.video;
    let AudioConfig {
        sample_rate,
        channels,
        bitrate: abr,
        ..
    } = config.audio;
    let props = vec![
        ("width".to_owned(), Amf::Number(width as f64)),
        ("height".to_owned(), Amf::Number(height as f64)),
        ("framerate".to_owned(), Amf::Number(framerate as f64)),
        ("videocodecid".to_owned(), Amf::Number(CODEC_AVC as f64)),
        ("videodatarate".to_owned(), Amf::Number(vbr as f64 / 1000.0)),
        ("audiocodecid".to_owned(), Amf::Number(10.0)),
        ("audiodatarate".to_owned(), Amf::Number(abr as f64 / 1000.0)),
        (
            "audiosamplerate".to_owned(),
            Amf::Number(sample_rate as f64),
        ),
        ("audiosamplesize".to_owned(), Amf::Number(16.0)),
        ("stereo".to_owned(), Amf::Bool(channels > 1)),
        (
            "encoder".to_owned(),
            Amf::str(concat!("streamFree ", env!("CARGO_PKG_VERSION"))),
        ),
    ];
    let mut values = Vec::new();
    if for_rtmp {
        values.push(Amf::str("@setDataFrame"));
    }
    values.push(Amf::str("onMetaData"));
    values.push(Amf::EcmaArray(props));
    encode_values(&values)
}

pub fn video_sequence_header(avcc: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(5 + avcc.len());
    out.put_u8((FRAME_KEY << 4) | CODEC_AVC);
    out.put_u8(AVC_SEQUENCE_HEADER);
    out.put_slice(&[0, 0, 0]);
    out.put_slice(avcc);
    out.freeze()
}

/// Video body for one access unit. The stream has no B-frames, so the
/// composition time offset is always zero.
pub fn video_frame(keyframe: bool, data: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(5 + data.len());
    let frame = if keyframe { FRAME_KEY } else { FRAME_INTER };
    out.put_u8((frame << 4) | CODEC_AVC);
    out.put_u8(AVC_NALU);
    out.put_slice(&[0, 0, 0]);
    out.put_slice(data);
    out.freeze()
}

pub fn audio_sequence_header(asc: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(2 + asc.len());
    out.put_u8(AAC_HEADER);
    out.put_u8(AAC_SEQUENCE_HEADER);
    out.put_slice(asc);
    out.freeze()
}

pub fn audio_frame(data: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(2 + data.len());
    out.put_u8(AAC_HEADER);
    out.put_u8(AAC_RAW);
    out.put_slice(data);
    out.freeze()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amf_round_trips() {
        let values = vec![
            Amf::str("connect"),
            Amf::Number(1.0),
            Amf::Object(vec![
                ("app".into(), Amf::str("live")),
                ("fpad".into(), Amf::Bool(false)),
            ]),
            Amf::Null,
            Amf::EcmaArray(vec![("width".into(), Amf::Number(1280.0))]),
        ];
        let bytes = encode_values(&values);
        assert_eq!(Amf::decode_all(&bytes), values);
    }

    #[test]
    fn amf_string_wire_format() {
        let mut out = BytesMut::new();
        Amf::str("ab").encode(&mut out);
        assert_eq!(&out[..], &[0x02, 0x00, 0x02, b'a', b'b']);
    }

    #[test]
    fn video_tag_bytes() {
        let body = video_frame(true, &[0, 0, 0, 1, 0x65]);
        assert_eq!(&body[..5], &[0x17, 0x01, 0, 0, 0]);
        let body = video_frame(false, &[0, 0, 0, 1, 0x41]);
        assert_eq!(body[0], 0x27);
    }
}
