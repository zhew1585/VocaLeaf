import base64
import json

import httpx
import pytest

from vocaleaf_worker.tts import KOKORO_VOICES, KokoroTts, Word, words_from_timestamps


def test_maps_every_voice_to_the_kokoro_voice_confirmed_by_listening():
    assert KOKORO_VOICES == {
        "us_female": "af_heart",
        "us_male": "am_michael",
        "uk_female": "bf_emma",
        "uk_male": "bm_george",
    }


def test_turns_kokoro_timestamps_into_words_in_milliseconds_without_punctuation():
    stamps = [
        {"word": "It", "start_time": -0.0215, "end_time": 0.1035},
        {"word": "is", "start_time": 0.1035, "end_time": 0.216},
        {"word": ",", "start_time": 0.216, "end_time": 0.3},
        {"word": "wife", "start_time": 1.9, "end_time": 2.6},
    ]

    # Kokoro may start a word slightly before zero and end the last one after the audio; both are clamped.
    assert words_from_timestamps(stamps, duration_ms=2500) == (
        Word("It", 0, 104),
        Word("is", 104, 216),
        Word("wife", 1900, 2500),
    )


@pytest.mark.parametrize(("voice", "kokoro"), list(KOKORO_VOICES.items()))
def test_asks_kokoro_for_pcm_with_word_timestamps_in_the_mapped_voice(voice, kokoro):
    requests: list[httpx.Request] = []
    pcm = b"\x01\x00" * 24_000  # one second

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        stamps = [{"word": "Hello", "start_time": 0.0, "end_time": 0.5}]
        return httpx.Response(200, json={"audio": base64.b64encode(pcm).decode(), "timestamps": stamps})

    tts = KokoroTts(httpx.Client(base_url="http://kokoro:8880", transport=httpx.MockTransport(handler)))
    speech = tts.synthesize("Hello.", voice)

    assert requests[0].url.path == "/dev/captioned_speech"
    body = json.loads(requests[0].content)
    assert body["voice"] == kokoro
    assert body["input"] == "Hello."
    assert (body["response_format"], body["stream"], body["return_timestamps"]) == ("pcm", False, True)
    assert speech.pcm == pcm
    assert speech.duration_ms == 1000
    assert speech.words == (Word("Hello", 0, 500),)


def test_raises_when_kokoro_answers_with_an_error():
    tts = KokoroTts(
        httpx.Client(base_url="http://kokoro:8880", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    )
    with pytest.raises(httpx.HTTPStatusError):
        tts.synthesize("Hello.", "us_female")
