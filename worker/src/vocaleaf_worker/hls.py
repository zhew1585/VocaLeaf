"""Streams PCM through ffmpeg into HLS segments: AAC mono 48 kbps, about 10 seconds each (PRD 4.7.2).

One ffmpeg process encodes a whole Chapter, so segment boundaries carry no encoder gaps or clicks. PCM is fed
as it is synthesized, and finished segments can be collected while the Chapter is still being written: ffmpeg
lists a segment in its playlist only once the segment file is complete.
"""

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Self

from vocaleaf_worker.tts import SAMPLE_RATE

SEGMENT_SECONDS = 10
AUDIO_BITRATE = "48k"
PLAYLIST = "index.m3u8"


@dataclass(frozen=True)
class Segment:
    index: int
    path: Path
    duration_ms: int


class HlsEncoder:
    """Context manager around one ffmpeg process. `write` PCM, poll `new_segments`, then `finish`."""

    def __init__(self) -> None:
        self._dir = tempfile.TemporaryDirectory(prefix="vocaleaf-hls-")
        self.dir = Path(self._dir.name)
        self._log = (self.dir / "ffmpeg.log").open("wb")
        self._proc = subprocess.Popen(
            [
                *("ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"),
                *("-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0"),
                *("-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "1"),
                *("-f", "hls", "-hls_time", str(SEGMENT_SECONDS), "-hls_list_size", "0"),
                *("-hls_playlist_type", "event", "-hls_flags", "temp_file", "-hls_segment_type", "mpegts"),
                *("-hls_segment_filename", str(self.dir / "seg-%05d.ts"), str(self.dir / PLAYLIST)),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=self._log,
        )
        self._seen = 0

    def write(self, pcm: bytes) -> None:
        assert self._proc.stdin is not None
        self._proc.stdin.write(pcm)
        self._proc.stdin.flush()

    def new_segments(self) -> list[Segment]:
        """Segments completed since the previous call."""
        done = self._listed()
        fresh = done[self._seen :]
        self._seen = len(done)
        return fresh

    def finish(self) -> list[Segment]:
        """Ends the stream, waits for ffmpeg and returns the segments not collected yet."""
        assert self._proc.stdin is not None
        self._proc.stdin.close()
        if self._proc.wait() != 0:
            self._log.flush()
            raise RuntimeError(f"ffmpeg failed: {(self.dir / 'ffmpeg.log').read_text(errors='replace')[-2000:]}")
        return self.new_segments()

    def _listed(self) -> list[Segment]:
        playlist = self.dir / PLAYLIST
        if not playlist.exists():
            return []
        segments: list[Segment] = []
        duration_ms: int | None = None
        for line in playlist.read_text().splitlines():
            if line.startswith("#EXTINF:"):
                duration_ms = round(float(line.removeprefix("#EXTINF:").split(",")[0]) * 1000)
            elif line and not line.startswith("#") and duration_ms is not None:
                segments.append(Segment(len(segments), self.dir / line, duration_ms))
                duration_ms = None
        return segments

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        if self._proc.poll() is None:
            self._proc.kill()
            self._proc.wait()
        self._log.close()
        self._dir.cleanup()
