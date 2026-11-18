"""Renders one Chapter (PRD 4.3.4 step 5): synthesizes each Sentence in order, streams the audio into HLS
segments in object storage, and reports segments and Sentence timings to the API as they are ready.

The first report goes out as soon as the first segment is written, so a Book becomes playable long before
its first Chapter is finished.
"""

import logging
from collections.abc import Callable

from vocaleaf_worker.api_client import ApiClient, RenderJob, TimedSentence, TimedWord, WrittenSegment
from vocaleaf_worker.hls import HlsEncoder, Segment
from vocaleaf_worker.storage import ObjectStorage
from vocaleaf_worker.tts import BYTES_PER_SAMPLE, Tts, samples_to_ms

log = logging.getLogger(__name__)

SEGMENT_CONTENT_TYPE = "video/mp2t"


def render_chapter(
    api: ApiClient,
    storage: ObjectStorage,
    tts: Tts,
    job: RenderJob,
    check_alive: Callable[[], None] = lambda: None,
) -> None:
    """Renders and reports the Chapter. `check_alive` raises to abandon the job (see Heartbeat.check)."""
    samples_so_far = 0
    unreported: list[TimedSentence] = []

    def upload(segments: list[Segment]) -> list[WrittenSegment]:
        written = []
        for s in segments:
            key = f"{job.audio_prefix}seg-{s.index:05d}.ts"
            storage.put_object(key, s.path.read_bytes(), SEGMENT_CONTENT_TYPE)
            written.append(WrittenSegment(s.index, key, s.duration_ms))
        return written

    with HlsEncoder() as encoder:
        for sentence in job.sentences:
            check_alive()
            speech = tts.synthesize(sentence.spoken_text, job.voice)
            start_ms = samples_to_ms(samples_so_far)
            samples_so_far += len(speech.pcm) // BYTES_PER_SAMPLE
            unreported.append(
                TimedSentence(
                    id=sentence.id,
                    start_ms=start_ms,
                    end_ms=samples_to_ms(samples_so_far),
                    words=tuple(TimedWord(w.word, w.start_ms, w.end_ms) for w in speech.words),
                )
            )
            encoder.write(speech.pcm)
            if fresh := encoder.new_segments():
                api.report_render_progress(job, upload(fresh), unreported)
                unreported = []
        check_alive()
        api.report_render_result(job, upload(encoder.finish()), unreported)
    log.info(
        "job %s: chapter %s, %d sentences, %d ms",
        job.id,
        job.chapter_id,
        len(job.sentences),
        samples_to_ms(samples_so_far),
    )
