"""A render job as the worker runs it: claim, synthesize every Sentence, write HLS segments to storage,
report progress and the result to the API, all while keeping the lease with heartbeats."""

import json
import subprocess

from fakes import FakeApi, FakeStorage, FakeTts, client
from vocaleaf_worker.worker import run_once

PREFIX = "books/b/audio/c/j-1/"


def render_job(sentence_count: int, lease_ms: int = 600_000) -> dict:
    return {
        "id": "22222222-2222-4222-8222-222222222222",
        "type": "render_chapter",
        "bookId": "b",
        "chapterId": "c",
        "attempt": 1,
        "leaseMs": lease_ms,
        "voice": "uk_male",
        "audioPrefix": PREFIX,
        "sentences": [{"id": f"s{i}", "spokenText": f"Sentence number {i}."} for i in range(sentence_count)],
    }


def reported(api: FakeApi, field: str) -> list[dict]:
    return [item for call in ("render-progress", "render-result") for body in api.bodies(call) for item in body[field]]


def probe(data: bytes) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", "-i", "pipe:0"],
        input=data,
        capture_output=True,
        check=True,
    )
    return json.loads(out.stdout)["streams"][0]


def test_renders_a_chapter_into_10_second_hls_segments_and_reports_every_sentence_timing():
    api, storage, tts = FakeApi(render_job(7)), FakeStorage(), FakeTts(sentence_ms=4000)

    assert run_once(client(api), storage, tts) is True

    # 7 Sentences of 4 s are 28 s of audio: segments of about 10, 10 and 8 seconds.
    segments = reported(api, "segments")
    assert [s["index"] for s in segments] == [0, 1, 2]
    assert [round(s["durationMs"] / 1000) for s in segments] == [10, 10, 8]
    assert abs(sum(s["durationMs"] for s in segments) - 28_000) < 100
    for s in segments:
        assert s["key"].startswith(PREFIX)
        assert storage.content_types[s["key"]] == "video/mp2t"
        assert storage.objects[s["key"]][0] == 0x47  # MPEG-TS sync byte

    sentences = reported(api, "sentences")
    assert [(s["id"], s["startMs"], s["endMs"]) for s in sentences] == [
        (f"s{i}", i * 4000, (i + 1) * 4000) for i in range(7)
    ]
    assert sentences[2]["wordTimings"] == [
        {"word": "Sentence", "startMs": 0, "endMs": 1333},
        {"word": "number", "startMs": 1333, "endMs": 2666},
        {"word": "2.", "startMs": 2666, "endMs": 3999},
    ]
    assert tts.calls[0] == ("Sentence number 0.", "uk_male")
    assert api.calls()[-1] == "render-result"
    assert all(b["attempt"] == 1 for b in api.bodies("render-progress") + api.bodies("render-result"))


def test_reports_the_first_segment_before_the_chapter_is_finished():
    api, storage, tts = FakeApi(render_job(7)), FakeStorage(), FakeTts(sentence_ms=4000)

    run_once(client(api), storage, tts)

    calls = api.calls()
    assert calls[0] == "claim"
    assert "render-progress" in calls
    first_progress = api.bodies("render-progress")[0]
    assert first_progress["segments"][0]["index"] == 0
    # Sentences after the first segment had not been synthesized yet when it was reported.
    assert len(first_progress["sentences"]) < 7


def test_encodes_aac_mono_at_48_kbps():
    api, storage = FakeApi(render_job(5)), FakeStorage()

    run_once(client(api), storage, FakeTts(sentence_ms=4000))

    stream = probe(storage.objects[f"{PREFIX}seg-00000.ts"])
    assert (stream["codec_name"], stream["profile"], stream["channels"]) == ("aac", "LC", 1)
    total_bytes = sum(len(v) for v in storage.objects.values())
    # 20 s at 48 kbps is 120 kB of AAC; MPEG-TS framing adds overhead on top.
    assert 100_000 < total_bytes < 200_000


def test_sends_heartbeats_while_rendering_takes_longer_than_a_heartbeat_interval():
    api = FakeApi(render_job(6))

    run_once(client(api), FakeStorage(), FakeTts(sentence_ms=500, delay_seconds=0.05), heartbeat_seconds=0.02)

    calls = api.calls()
    assert calls.count("heartbeat") >= 5
    assert calls.index("heartbeat") < calls.index("render-result")
    assert all(b == {"attempt": 1} for b in api.bodies("heartbeat"))


def test_derives_the_heartbeat_interval_from_the_lease():
    api = FakeApi(render_job(6, lease_ms=150))  # a beat every 50 ms

    run_once(client(api), FakeStorage(), FakeTts(sentence_ms=500, delay_seconds=0.05))

    assert api.calls().count("heartbeat") >= 3


def test_stops_rendering_once_a_heartbeat_is_refused(caplog):
    api = FakeApi(render_job(40), refuse=frozenset({"heartbeat"}))
    tts = FakeTts(sentence_ms=500, delay_seconds=0.02)

    assert run_once(client(api), FakeStorage(), tts, heartbeat_seconds=0.05) is True

    assert "render-result" not in api.calls()
    assert len(tts.calls) < 40
    assert "superseded" in caplog.text


def test_reports_a_failure_when_speech_cannot_be_synthesized():
    api = FakeApi(render_job(3))

    run_once(client(api), FakeStorage(), FakeTts(fail_on="Sentence number 1."))

    assert api.calls()[-1] == "failure"
    assert "kokoro unreachable" in api.bodies("failure")[0]["error"]
    assert "render-result" not in api.calls()
