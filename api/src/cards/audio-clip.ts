// Cuts one Sentence's audio out of its Chapter's HLS segments, for the copy a Card keeps (PRD 4.5.2 audio_url,
// AC-CARD-07). The worker's segments are AAC in MPEG-TS (worker/src/vocaleaf_worker/hls.py), one ffmpeg run per
// Chapter, so the AAC frames run on without gaps across segments. The clip is those frames as one ADTS stream
// (`audio/aac`), which every browser's <audio> plays; no decoding or re-encoding, so the API needs no ffmpeg.
// Frames are cut whole, about 43 ms at 24 kHz, so a clip may start and end up to one frame wider than the Sentence.

const TS_PACKET = 188;
const TS_SYNC = 0x47;
const ADTS_HEADER = 7;
/** ADTS sampling_frequency_index to Hz (ISO 14496-3). */
const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** One AAC frame with its ADTS header, and how long it plays. */
export interface AdtsFrame {
  bytes: Uint8Array;
  durationMs: number;
}

/** A segment of a Chapter's audio and where it starts in the Chapter (the sum of the segments before it). */
export interface ClipSegment {
  bytes: Uint8Array;
  startMs: number;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Whether a PES packet of an audio stream (stream_id 0xC0 to 0xDF) starts this payload. */
function startsAudioPes(payload: Uint8Array): boolean {
  return payload.length >= 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1 && (payload[3]! & 0xe0) === 0xc0;
}

/** The elementary stream of the first audio stream in MPEG-TS bytes: its PES payloads, headers dropped. */
function audioStream(ts: Uint8Array): Uint8Array {
  if (ts.length % TS_PACKET !== 0 || ts[0] !== TS_SYNC) throw new Error("not MPEG-TS");
  let audioPid: number | null = null;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < ts.length; i += TS_PACKET) {
    if (ts[i] !== TS_SYNC) throw new Error(`lost MPEG-TS sync at byte ${i}`);
    const unitStart = (ts[i + 1]! & 0x40) !== 0;
    const pid = ((ts[i + 1]! & 0x1f) << 8) | ts[i + 2]!;
    const adaptation = (ts[i + 3]! >> 4) & 3;
    if (adaptation === 0 || adaptation === 2) continue;
    const at = adaptation === 3 ? i + 5 + ts[i + 4]! : i + 4;
    let payload = ts.subarray(at, i + TS_PACKET);
    if (audioPid === null && unitStart && startsAudioPes(payload)) audioPid = pid;
    if (pid !== audioPid) continue;
    if (unitStart) payload = payload.subarray(9 + payload[8]!);
    parts.push(payload);
  }
  return concat(parts);
}

/** Splits an ADTS stream into its frames. Throws on bytes that are not ADTS. */
export function splitAdts(es: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let at = 0; at < es.length; ) {
    if (at + ADTS_HEADER > es.length || es[at] !== 0xff || (es[at + 1]! & 0xf6) !== 0xf0) {
      throw new Error(`no ADTS frame at byte ${at}`);
    }
    const length = ((es[at + 3]! & 3) << 11) | (es[at + 4]! << 3) | (es[at + 5]! >> 5);
    if (length < ADTS_HEADER || at + length > es.length) throw new Error(`cut-off ADTS frame at byte ${at}`);
    frames.push(es.subarray(at, at + length));
    at += length;
  }
  return frames;
}

/** The AAC frames of an MPEG-TS segment in order. Throws when it is not MPEG-TS carrying ADTS audio. */
export function adtsFramesOf(ts: Uint8Array): AdtsFrame[] {
  return splitAdts(audioStream(ts)).map((bytes) => {
    const rate = SAMPLE_RATES[(bytes[2]! >> 2) & 0xf];
    if (!rate) throw new Error("ADTS frame with an unknown sampling rate");
    // Each raw data block holds 1024 samples.
    const blocks = (bytes[6]! & 3) + 1;
    return { bytes, durationMs: (blocks * 1024 * 1000) / rate };
  });
}

/**
 * The frames of `segments` (in order) that play during [startMs, endMs) of the Chapter, as one ADTS stream; empty
 * when none do. Each frame is placed by its segment's start, so a long Chapter does not drift.
 */
export function cutClip(segments: ClipSegment[], startMs: number, endMs: number): Uint8Array {
  const kept: Uint8Array[] = [];
  for (const segment of segments) {
    let t = segment.startMs;
    for (const frame of adtsFramesOf(segment.bytes)) {
      if (t + frame.durationMs > startMs && t < endMs) kept.push(frame.bytes);
      t += frame.durationMs;
    }
  }
  return concat(kept);
}
