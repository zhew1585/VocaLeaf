"""Renders one sample per Voice through the real pipeline (Kokoro, then AAC mono 48 kbps) and prints how much
faster than playback each was generated. Used to confirm the Voice to Kokoro voice mapping (PRD 4.7.2, O6).

    docker compose run --rm --no-deps -v "$PWD/worker/scripts:/scripts:ro" -v "$PWD/docs/samples/issue-2:/out" \\
      worker python /scripts/voice_samples.py /out

With a second directory it also writes the 5-second previews the upload dialog plays (PRD 4.2.4, #19) as
`{voice}.m4a`: static files, so choosing a Voice never waits on Kokoro. Run it again whenever KOKORO_VOICES changes:

    docker compose run --rm --no-deps -v "$PWD/worker/scripts:/scripts:ro" -v "$PWD/docs/samples/issue-2:/out" \\
      -v "$PWD/web/public/voices:/previews" worker python /scripts/voice_samples.py /out /previews
"""

import os
import subprocess
import sys
import time

import httpx

from vocaleaf_worker.hls import AUDIO_BITRATE
from vocaleaf_worker.tts import BYTES_PER_SAMPLE, KOKORO_VOICES, SAMPLE_RATE, KokoroTts

# The opening of Pride and Prejudice, Chapter I.
TEXT = [
    (
        "It is a truth universally acknowledged, that a single man in possession of a good fortune, "
        "must be in want of a wife."
    ),
    (
        "However little known the feelings or views of such a man may be on his first entering a neighbourhood, "
        "this truth is so well fixed in the minds of the surrounding families, that he is considered as the rightful "
        "property of some one or other of their daughters."
    ),
]


# A preview is the sample's first seconds, faded out at the end.
PREVIEW_SECONDS = 5
PREVIEW_FADE_SECONDS = 0.4


def encode(pcm: bytes, path: str, extra: list[str]) -> None:
    """Encodes 16-bit mono PCM as AAC at the app's bitrate; `extra` cuts or filters it."""
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "1",
            "-i",
            "pipe:0",
            *extra,
            "-c:a",
            "aac",
            "-b:a",
            AUDIO_BITRATE,
            path,
        ],
        input=pcm,
        check=True,
    )


def main(out_dir: str, previews_dir: str | None = None) -> None:
    tts = KokoroTts(httpx.Client(base_url=os.environ["KOKORO_URL"], timeout=300))
    tts.synthesize("Warm up.", "us_female")
    for voice, kokoro in KOKORO_VOICES.items():
        started = time.monotonic()
        pcm = b"".join(tts.synthesize(sentence, voice).pcm for sentence in TEXT)
        elapsed = time.monotonic() - started
        audio_seconds = len(pcm) / BYTES_PER_SAMPLE / SAMPLE_RATE
        encode(pcm, os.path.join(out_dir, f"{voice}-{kokoro}.m4a"), [])
        if previews_dir:
            fade_start = PREVIEW_SECONDS - PREVIEW_FADE_SECONDS
            encode(
                pcm,
                os.path.join(previews_dir, f"{voice}.m4a"),
                ["-t", str(PREVIEW_SECONDS), "-af", f"afade=t=out:st={fade_start}:d={PREVIEW_FADE_SECONDS}"],
            )
        print(
            f"{voice:10} {kokoro:11} {audio_seconds:5.1f} s audio in {elapsed:5.1f} s: {audio_seconds / elapsed:.1f}x"
        )


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
