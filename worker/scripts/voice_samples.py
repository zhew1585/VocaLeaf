"""Renders one sample per Voice through the real pipeline (Kokoro, then AAC mono 48 kbps) and prints how much
faster than playback each was generated. Used to confirm the Voice to Kokoro voice mapping (PRD 4.7.2, O6).

    docker compose run --rm --no-deps -v "$PWD/worker/scripts:/scripts:ro" -v "$PWD/docs/samples/issue-2:/out" \\
      worker python /scripts/voice_samples.py /out
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


def main(out_dir: str) -> None:
    tts = KokoroTts(httpx.Client(base_url=os.environ["KOKORO_URL"], timeout=300))
    tts.synthesize("Warm up.", "us_female")
    for voice, kokoro in KOKORO_VOICES.items():
        started = time.monotonic()
        pcm = b"".join(tts.synthesize(sentence, voice).pcm for sentence in TEXT)
        elapsed = time.monotonic() - started
        audio_seconds = len(pcm) / BYTES_PER_SAMPLE / SAMPLE_RATE
        path = os.path.join(out_dir, f"{voice}-{kokoro}.m4a")
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
                "-c:a",
                "aac",
                "-b:a",
                AUDIO_BITRATE,
                path,
            ],
            input=pcm,
            check=True,
        )
        print(
            f"{voice:10} {kokoro:11} {audio_seconds:5.1f} s audio in {elapsed:5.1f} s: {audio_seconds / elapsed:.1f}x"
        )


if __name__ == "__main__":
    main(sys.argv[1])
