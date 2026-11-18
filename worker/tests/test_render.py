"""A render job as the worker runs it: claim, synthesize the Chapter paragraph by paragraph, lay it out with
the configured pauses, write HLS segments to storage and report progress and the result to the API, all while
keeping the lease with heartbeats. The audio really goes through ffmpeg and is decoded back to check it."""

import itertools
import json
import math
import struct
import subprocess

from fakes import FakeApi, FakeStorage, FakeTts, client
from vocaleaf_worker.narration import Pauses
from vocaleaf_worker.tts import SAMPLE_RATE
from vocaleaf_worker.worker import run_once

PREFIX = "books/b/audio/c/j-1/"
PAUSES = Pauses(sentence_ms=300, paragraph_ms=800, chapter_start_ms=1500)


def render_job(paragraphs: list[int], lease_ms: int = 600_000, words: int = 3) -> dict:
    """A render job with one Sentence per entry of `paragraphs` (its paragraph index), each `words` words long."""
    filler = " ".join(["word"] * (words - 2))
    return {
        "id": "22222222-2222-4222-8222-222222222222",
        "type": "render_chapter",
        "bookId": "b",
        "chapterId": "c",
        "attempt": 1,
        "leaseMs": lease_ms,
        "voice": "uk_male",
        "audioPrefix": PREFIX,
        "sentences": [
            {"id": f"s{i}", "spokenText": f"Sentence {filler} {i}.".replace("  ", " "), "paragraphIndex": p}
            for i, p in enumerate(paragraphs)
        ],
    }


def run(job: dict, tts: FakeTts | None = None, storage: FakeStorage | None = None, **kwargs) -> FakeApi:
    api = FakeApi(job)
    run_once(client(api), storage or FakeStorage(), tts or FakeTts(), pauses=PAUSES, **kwargs)
    return api


def reported(api: FakeApi, field: str) -> list[dict]:
    return [item for call in ("render-progress", "render-result") for body in api.bodies(call) for item in body[field]]


def decode(storage: FakeStorage, segments: list[dict]) -> list[int]:
    """The Chapter's audio as players hear it: every segment in order, decoded back to PCM."""
    stream = b"".join(storage.objects[s["key"]] for s in segments)
    pcm = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "pipe:1"],
        input=stream,
        capture_output=True,
        check=True,
    ).stdout
    return [v for (v,) in struct.iter_unpack("<h", pcm)]


def rms(values: list[int], from_ms: int, to_ms: int) -> float:
    window = values[SAMPLE_RATE * from_ms // 1000 : SAMPLE_RATE * to_ms // 1000]
    return math.sqrt(sum(v * v for v in window) / max(len(window), 1))


def probe(data: bytes) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", "-i", "pipe:0"],
        input=data,
        capture_output=True,
        check=True,
    )
    return json.loads(out.stdout)["streams"][0]


def test_synthesizes_each_paragraph_in_one_call_so_the_voice_hears_its_context():
    tts = FakeTts()

    run(render_job([0, 0, 0, 1, 1, 2]), tts)

    assert [text for text, _ in tts.calls] == [
        "Sentence word 0. Sentence word 1. Sentence word 2.",
        "Sentence word 3. Sentence word 4.",
        "Sentence word 5.",
    ]
    assert {voice for _, voice in tts.calls} == {"uk_male"}


def test_opens_the_chapter_and_separates_sentences_and_paragraphs_with_the_configured_silence():
    storage = FakeStorage()

    api = run(render_job([0, 0, 0, 1, 1, 2]), storage=storage)

    sentences = reported(api, "sentences")
    times = [(s["startMs"], s["endMs"]) for s in sentences]
    # Each Sentence is exactly its voiced span: 3 words of 300 ms, no silence inside.
    assert all(end - start == 900 for start, end in times)
    assert times[0][0] == 1500
    gaps = [times[i][0] - times[i - 1][1] for i in range(1, len(times))]
    assert gaps == [300, 300, 800, 300, 800]

    # In the decoded audio the gaps are silent and the Sentences are not.
    audio = decode(storage, reported(api, "segments"))
    assert rms(audio, 100, 1350) < 50
    for i, (start, end) in enumerate(times):
        assert rms(audio, start + 50, end - 50) > 3000, f"sentence {i} is silent"
        if i > 0:
            gap_start = times[i - 1][1]
            assert rms(audio, gap_start + 110, start - 110) < 300, f"gap before sentence {i} is not silent"


def test_reports_word_timings_inside_each_sentence_and_sentence_ids_in_reading_order():
    api = run(render_job([0, 0, 1, 1]))

    sentences = reported(api, "sentences")
    assert [s["id"] for s in sentences] == ["s0", "s1", "s2", "s3"]
    for s in sentences:
        length = s["endMs"] - s["startMs"]
        assert [w["word"] for w in s["wordTimings"]] == ["Sentence", "word", s["id"][1:]]
        assert all(0 <= w["startMs"] < w["endMs"] <= length for w in s["wordTimings"])
    assert all(a["endMs"] <= b["startMs"] for a, b in itertools.pairwise(sentences))


def test_falls_back_to_one_sentence_at_a_time_when_a_paragraphs_words_cannot_be_aligned():
    tts = FakeTts(drop_words_of="Sentence word 1.")

    api = run(render_job([0, 0, 0]), tts)

    texts = [text for text, _ in tts.calls]
    assert texts[0] == "Sentence word 0. Sentence word 1. Sentence word 2."
    assert texts[1:] == ["Sentence word 0.", "Sentence word 1.", "Sentence word 2."]
    sentences = reported(api, "sentences")
    assert [len(s["wordTimings"]) for s in sentences] == [3, 3, 3]
    assert [s["startMs"] - p["endMs"] for p, s in itertools.pairwise(sentences)] == [300, 300]


def test_cuts_10_second_segments_whose_total_covers_every_sentence_and_pause():
    storage = FakeStorage()

    # Two paragraphs of six 6-word Sentences (1.8 s each) and 5.3 s of pauses: about 27 s of audio.
    api = run(render_job([0] * 6 + [1] * 6, words=6), storage=storage)

    segments = reported(api, "segments")
    assert [s["index"] for s in segments] == [0, 1, 2]
    assert [round(s["durationMs"] / 1000) for s in segments[:2]] == [10, 10]
    last_end = reported(api, "sentences")[-1]["endMs"]
    assert last_end <= sum(s["durationMs"] for s in segments) <= last_end + 300
    for s in segments:
        assert s["key"].startswith(PREFIX)
        assert storage.content_types[s["key"]] == "video/mp2t"
        assert storage.objects[s["key"]][0] == 0x47  # MPEG-TS sync byte
    assert api.calls()[-1] == "render-result"
    assert all(b["attempt"] == 1 for b in api.bodies("render-progress") + api.bodies("render-result"))


def test_reports_the_first_segment_before_the_chapter_is_finished():
    api = run(render_job([0, 1, 2, 3, 4, 5, 6], words=7))

    first_progress = api.bodies("render-progress")[0]
    assert first_progress["segments"][0]["index"] == 0
    # Sentences after the first segment had not been synthesized yet when it was reported.
    assert len(first_progress["sentences"]) < 7


def test_encodes_aac_mono_at_48_kbps():
    storage = FakeStorage()

    run(render_job([0, 1, 2, 3, 4], words=7), storage=storage)

    stream = probe(storage.objects[f"{PREFIX}seg-00000.ts"])
    assert (stream["codec_name"], stream["profile"], stream["channels"]) == ("aac", "LC", 1)
    seconds = sum(len(v) for v in storage.objects.values()) / 6000
    # 48 kbps is 6 kB per second of audio; MPEG-TS framing adds overhead on top.
    assert 10 < seconds < 30


def test_sends_heartbeats_while_rendering_takes_longer_than_a_heartbeat_interval():
    api = run(render_job([0, 1, 2, 3, 4, 5]), FakeTts(delay_seconds=0.05), heartbeat_seconds=0.02)

    calls = api.calls()
    assert calls.count("heartbeat") >= 5
    assert calls.index("heartbeat") < calls.index("render-result")
    assert all(b == {"attempt": 1} for b in api.bodies("heartbeat"))


def test_derives_the_heartbeat_interval_from_the_lease():
    api = run(render_job([0, 1, 2, 3, 4, 5], lease_ms=150), FakeTts(delay_seconds=0.05))  # a beat every 50 ms

    assert api.calls().count("heartbeat") >= 3


def test_stops_rendering_once_a_heartbeat_is_refused(caplog):
    api = FakeApi(render_job(list(range(40))), refuse=frozenset({"heartbeat"}))
    tts = FakeTts(delay_seconds=0.02)

    assert run_once(client(api), FakeStorage(), tts, pauses=PAUSES, heartbeat_seconds=0.05) is True

    assert "render-result" not in api.calls()
    assert len(tts.calls) < 40
    assert "superseded" in caplog.text


def test_reports_a_failure_when_speech_cannot_be_synthesized():
    api = run(render_job([0, 1, 2]), FakeTts(fail_on="Sentence word 1."))

    assert api.calls()[-1] == "failure"
    assert "kokoro unreachable" in api.bodies("failure")[0]["error"]
    assert "render-result" not in api.calls()
