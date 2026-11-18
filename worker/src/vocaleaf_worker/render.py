"""Renders one Chapter (PRD 4.3.4 step 5): synthesizes it paragraph by paragraph, lays the audio out with the
configured pauses (see narration.py), streams it into HLS segments in object storage, and reports segments and
Sentence timings to the API as they are ready.

The first report goes out as soon as the first segment is written, so a Book becomes playable long before
its first Chapter is finished.
"""

import logging
from collections.abc import Callable, Iterator, Sequence

from vocaleaf_worker.api_client import ApiClient, RenderJob, SentenceToSpeak, TimedSentence, WrittenSegment
from vocaleaf_worker.hls import HlsEncoder, Segment
from vocaleaf_worker.narration import (
    ChapterAssembler,
    Pauses,
    SpokenSentence,
    align_words,
    pauses_before,
    plan_passages,
)
from vocaleaf_worker.storage import ObjectStorage
from vocaleaf_worker.tts import Speech, Tts, Voice

log = logging.getLogger(__name__)

SEGMENT_CONTENT_TYPE = "video/mp2t"


def speak(
    tts: Tts, passage: Sequence[SentenceToSpeak], voice: Voice, check_alive: Callable[[], None]
) -> Iterator[tuple[list[SpokenSentence], Speech]]:
    """Synthesizes a passage in one call and splits its words by Sentence. If the words cannot be aligned with
    the Sentences, the passage is spoken again one Sentence at a time, which always aligns."""
    speech = tts.synthesize(" ".join(s.spoken_text for s in passage), voice)
    aligned = align_words(passage, speech.words)
    if aligned is not None:
        yield [SpokenSentence(s, ws) for s, ws in zip(passage, aligned, strict=True)], speech
        return
    if len(passage) == 1:
        yield [SpokenSentence(passage[0], speech.words)], speech
        return
    log.warning(
        "could not align %d sentences spoken together (%.60s); speaking them one by one",
        len(passage),
        passage[0].spoken_text,
    )
    for sentence in passage:
        check_alive()
        alone = tts.synthesize(sentence.spoken_text, voice)
        yield [SpokenSentence(sentence, alone.words)], alone


def render_chapter(
    api: ApiClient,
    storage: ObjectStorage,
    tts: Tts,
    job: RenderJob,
    pauses: Pauses,
    check_alive: Callable[[], None] = lambda: None,
) -> None:
    """Renders and reports the Chapter. `check_alive` raises to abandon the job (see Heartbeat.check)."""
    assembler = ChapterAssembler(pauses_before(job.sentences, pauses))
    unreported: list[TimedSentence] = []

    def upload(segments: list[Segment]) -> list[WrittenSegment]:
        written = []
        for s in segments:
            key = f"{job.audio_prefix}seg-{s.index:05d}.ts"
            storage.put_object(key, s.path.read_bytes(), SEGMENT_CONTENT_TYPE)
            written.append(WrittenSegment(s.index, key, s.duration_ms))
        return written

    with HlsEncoder() as encoder:
        for passage in plan_passages(job.sentences):
            check_alive()
            for spoken, speech in speak(tts, passage, job.voice, check_alive):
                pcm, timed = assembler.add(spoken, speech)
                unreported.extend(timed)
                encoder.write(pcm)
                if fresh := encoder.new_segments():
                    api.report_render(job, upload(fresh), unreported, finished=False)
                    unreported = []
        check_alive()
        api.report_render(job, upload(encoder.finish()), unreported, finished=True)
    log.info("job %s: chapter %s, %d sentences", job.id, job.chapter_id, len(job.sentences))
