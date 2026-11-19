// Builds MPEG-TS segments of fake AAC frames, so tests can play the worker with segments whose audio the API can cut
// (cards/audio-clip.ts) without ffmpeg. The frames are ADTS headers (AAC LC, 24 kHz, mono) over a few bytes that
// say which segment they came from; no player could decode them, the API never needs to.

const SAMPLE_RATE_INDEX_24K = 6;
const FRAME_MS = 1024 / 24;
const PACKET = 188;
const AUDIO_PID = 0x100;

/** One fake ADTS frame of 8 payload bytes, the first of them `tag`. */
function adtsFrame(tag: number): Uint8Array {
  const length = 7 + 8;
  const header = [
    0xff,
    0xf1,
    (1 << 6) | (SAMPLE_RATE_INDEX_24K << 2),
    (1 << 6) | ((length >> 11) & 3),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc,
  ];
  return new Uint8Array([...header, tag & 0xff, 0, 0, 0, 0, 0, 0, 0]);
}

/** A PES packet of the audio stream carrying `es`, with a zero PTS. */
function pes(es: Uint8Array): Uint8Array {
  const header = [0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1];
  const length = es.length + 8;
  if (length < 0x10000) [header[4], header[5]] = [length >> 8, length & 0xff];
  return new Uint8Array([...header, ...es]);
}

/** Splits a PES packet into TS packets on AUDIO_PID, padding the last with adaptation-field stuffing. */
function packets(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0, n = 0; i < data.length; i += 184, n++) {
    const chunk = data.subarray(i, i + 184);
    const start = i === 0 ? 0x40 : 0;
    const stuffing = 184 - chunk.length;
    const afc = stuffing > 0 ? 3 : 1;
    out.push(0x47, start | (AUDIO_PID >> 8), AUDIO_PID & 0xff, (afc << 4) | (n & 0xf));
    if (stuffing > 0) {
      out.push(stuffing - 1);
      if (stuffing > 1) out.push(0, ...new Array<number>(stuffing - 2).fill(0xff));
    }
    out.push(...chunk);
  }
  if (out.length % PACKET !== 0) throw new Error("bad TS packet size");
  return new Uint8Array(out);
}

/** A TS segment of about `durationMs` of fake AAC frames (whole frames, so a little shorter), each tagged `tag`. */
export function fakeTsSegment(durationMs: number, tag: number): Uint8Array {
  const count = Math.floor(durationMs / FRAME_MS);
  const frames = Array.from({ length: count }, () => adtsFrame(tag));
  const es = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  frames.reduce((at, f) => (es.set(f, at), at + f.length), 0);
  return packets(pes(es));
}
