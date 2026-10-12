//! RTMP chunk stream (Adobe "Real-Time Messaging Protocol (RTMP) specification",
//! section 5.3): splitting outgoing messages into chunks and reassembling
//! incoming ones.

use bytes::{Buf, BufMut, Bytes, BytesMut};
use std::collections::HashMap;

pub const MSG_SET_CHUNK_SIZE: u8 = 1;
pub const MSG_ACK: u8 = 3;
pub const MSG_USER_CONTROL: u8 = 4;
pub const MSG_WINDOW_ACK_SIZE: u8 = 5;
pub const MSG_AUDIO: u8 = 8;
pub const MSG_VIDEO: u8 = 9;
pub const MSG_DATA_AMF0: u8 = 18;
pub const MSG_COMMAND_AMF0: u8 = 20;

const EXTENDED_TIMESTAMP: u32 = 0xFF_FFFF;
/// Largest message we accept from a server. Servers only send small control
/// and command messages to a publisher.
const MAX_INCOMING_MESSAGE: usize = 1 << 20;

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub csid: u32,
    pub timestamp: u32,
    pub msg_type: u8,
    pub stream_id: u32,
    pub payload: Bytes,
}

fn put_basic_header(out: &mut BytesMut, fmt: u8, csid: u32) {
    match csid {
        2..=63 => out.put_u8((fmt << 6) | csid as u8),
        64..=319 => {
            out.put_u8(fmt << 6);
            out.put_u8((csid - 64) as u8);
        }
        _ => {
            out.put_u8((fmt << 6) | 1);
            out.put_u16_le((csid - 64) as u16);
        }
    }
}

/// Serializes a message as one type-0 chunk followed by type-3 continuation
/// chunks. Type-0 headers carry absolute timestamps, so no per-stream state
/// has to be tracked on the sending side.
pub fn encode_message(
    out: &mut BytesMut,
    chunk_size: usize,
    csid: u32,
    msg_type: u8,
    stream_id: u32,
    timestamp: u32,
    payload: &[u8],
) {
    let extended = timestamp >= EXTENDED_TIMESTAMP;
    put_basic_header(out, 0, csid);
    let ts_field = if extended {
        EXTENDED_TIMESTAMP
    } else {
        timestamp
    };
    out.put_slice(&ts_field.to_be_bytes()[1..]);
    out.put_slice(&(payload.len() as u32).to_be_bytes()[1..]);
    out.put_u8(msg_type);
    out.put_u32_le(stream_id);
    if extended {
        out.put_u32(timestamp);
    }
    let mut chunks = payload.chunks(chunk_size.max(1));
    if let Some(first) = chunks.next() {
        out.put_slice(first);
    }
    for chunk in chunks {
        put_basic_header(out, 3, csid);
        if extended {
            out.put_u32(timestamp);
        }
        out.put_slice(chunk);
    }
}

#[derive(Debug, Default, Clone)]
struct ChunkState {
    timestamp: u32,
    timestamp_delta: u32,
    length: usize,
    msg_type: u8,
    stream_id: u32,
    extended: bool,
    partial: BytesMut,
}

#[derive(Debug, thiserror::Error)]
pub enum ChunkError {
    #[error("incoming RTMP message too large ({0} bytes)")]
    TooLarge(usize),
    #[error("continuation chunk on unknown chunk stream {0}")]
    UnknownStream(u32),
}

/// Incremental parser for the server-to-client chunk stream.
pub struct ChunkReader {
    chunk_size: usize,
    streams: HashMap<u32, ChunkState>,
    buffer: BytesMut,
}

impl Default for ChunkReader {
    fn default() -> Self {
        Self {
            chunk_size: 128,
            streams: HashMap::new(),
            buffer: BytesMut::new(),
        }
    }
}

impl ChunkReader {
    pub fn feed(&mut self, data: &[u8]) {
        self.buffer.extend_from_slice(data);
    }

    /// Returns the next complete message, `Ok(None)` when more bytes are needed.
    pub fn next_message(&mut self) -> Result<Option<Message>, ChunkError> {
        loop {
            match self.try_chunk()? {
                Step::NeedMore => return Ok(None),
                Step::Partial => continue,
                Step::Complete(msg) => {
                    if msg.msg_type == MSG_SET_CHUNK_SIZE && msg.payload.len() >= 4 {
                        let size =
                            u32::from_be_bytes(msg.payload[..4].try_into().unwrap()) & 0x7FFF_FFFF;
                        self.chunk_size = (size as usize).clamp(1, MAX_INCOMING_MESSAGE);
                    }
                    return Ok(Some(msg));
                }
            }
        }
    }

    fn try_chunk(&mut self) -> Result<Step, ChunkError> {
        let buf = &self.buffer[..];
        let Some(&first) = buf.first() else {
            return Ok(Step::NeedMore);
        };
        let fmt = first >> 6;
        let (csid, mut pos) = match first & 0x3F {
            0 => match buf.get(1) {
                Some(b) => (*b as u32 + 64, 2),
                None => return Ok(Step::NeedMore),
            },
            1 => match buf.get(1..3) {
                Some(b) => (u16::from_le_bytes([b[0], b[1]]) as u32 + 64, 3),
                None => return Ok(Step::NeedMore),
            },
            id => (id as u32, 1),
        };
        let header_len = [11, 7, 3, 0][fmt as usize];
        let Some(header) = buf.get(pos..pos + header_len) else {
            return Ok(Step::NeedMore);
        };
        pos += header_len;

        let prev = self.streams.get(&csid).cloned();
        if fmt != 0 && prev.is_none() {
            return Err(ChunkError::UnknownStream(csid));
        }
        let mut state = prev.unwrap_or_default();
        let starting = state.partial.is_empty();
        let ts_field = if fmt <= 2 {
            u32::from_be_bytes([0, header[0], header[1], header[2]])
        } else {
            0
        };
        if fmt <= 1 {
            state.length = u32::from_be_bytes([0, header[3], header[4], header[5]]) as usize;
            state.msg_type = header[6];
            if state.length > MAX_INCOMING_MESSAGE {
                return Err(ChunkError::TooLarge(state.length));
            }
        }
        if fmt == 0 {
            state.stream_id = u32::from_le_bytes([header[7], header[8], header[9], header[10]]);
        }
        let extended = if fmt <= 2 {
            ts_field == EXTENDED_TIMESTAMP
        } else {
            state.extended
        };
        let mut ts_value = ts_field;
        if extended {
            let Some(ext) = buf.get(pos..pos + 4) else {
                return Ok(Step::NeedMore);
            };
            ts_value = u32::from_be_bytes(ext.try_into().unwrap());
            pos += 4;
        }
        let remaining = state.length - state.partial.len();
        let take = remaining.min(self.chunk_size);
        if buf.len() < pos + take {
            return Ok(Step::NeedMore);
        }
        let body = Bytes::copy_from_slice(&buf[pos..pos + take]);
        self.buffer.advance(pos + take);

        state.extended = extended;
        if starting {
            match fmt {
                0 => {
                    state.timestamp = ts_value;
                    state.timestamp_delta = 0;
                }
                1 | 2 => {
                    state.timestamp_delta = ts_value;
                    state.timestamp = state.timestamp.wrapping_add(ts_value);
                }
                _ => state.timestamp = state.timestamp.wrapping_add(state.timestamp_delta),
            }
        }
        state.partial.extend_from_slice(&body);
        let done = state.partial.len() >= state.length;
        let result = if done {
            let payload = std::mem::take(&mut state.partial).freeze();
            Step::Complete(Message {
                csid,
                timestamp: state.timestamp,
                msg_type: state.msg_type,
                stream_id: state.stream_id,
                payload,
            })
        } else {
            Step::Partial
        };
        self.streams.insert(csid, state);
        Ok(result)
    }
}

enum Step {
    NeedMore,
    Partial,
    Complete(Message),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(chunk_size: usize, timestamp: u32, len: usize) {
        let payload: Vec<u8> = (0..len).map(|i| i as u8).collect();
        let mut out = BytesMut::new();
        encode_message(&mut out, chunk_size, 6, MSG_VIDEO, 1, timestamp, &payload);
        let mut reader = ChunkReader {
            chunk_size,
            ..Default::default()
        };
        // Feed one byte at a time to exercise every partial path.
        let mut got = None;
        for b in out.iter() {
            reader.feed(&[*b]);
            if let Some(msg) = reader.next_message().unwrap() {
                got = Some(msg);
            }
        }
        let msg = got.expect("message parsed");
        assert_eq!(msg.timestamp, timestamp);
        assert_eq!(msg.msg_type, MSG_VIDEO);
        assert_eq!(msg.stream_id, 1);
        assert_eq!(&msg.payload[..], &payload[..]);
    }

    #[test]
    fn chunks_round_trip() {
        round_trip(128, 1000, 10);
        round_trip(128, 1000, 1000);
        round_trip(4096, 42, 10_000);
    }

    #[test]
    fn extended_timestamps_round_trip() {
        round_trip(128, 0x0100_0000, 300);
    }

    #[test]
    fn honours_set_chunk_size() {
        let mut out = BytesMut::new();
        encode_message(
            &mut out,
            128,
            2,
            MSG_SET_CHUNK_SIZE,
            0,
            0,
            &4096u32.to_be_bytes(),
        );
        let big = vec![7u8; 3000];
        encode_message(&mut out, 4096, 3, MSG_COMMAND_AMF0, 0, 0, &big);
        let mut reader = ChunkReader::default();
        reader.feed(&out);
        let first = reader.next_message().unwrap().unwrap();
        assert_eq!(first.msg_type, MSG_SET_CHUNK_SIZE);
        let second = reader.next_message().unwrap().unwrap();
        assert_eq!(second.payload.len(), 3000);
    }

    #[test]
    fn basic_header_forms() {
        let mut out = BytesMut::new();
        put_basic_header(&mut out, 3, 3);
        put_basic_header(&mut out, 0, 100);
        put_basic_header(&mut out, 1, 1000);
        assert_eq!(&out[..], &[0xC3, 0x00, 36, 0x41, 0xA8, 0x03]);
    }
}
