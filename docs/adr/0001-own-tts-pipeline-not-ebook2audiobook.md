# Own thin TTS pipeline with self-hosted Kokoro, not ebook2audiobook

We build our own pipeline (parse ebook, split into Sentences with stable IDs, synthesize with self-hosted Kokoro, package as HLS) instead of wrapping ebook2audiobook.
The Sentence is the anchor that text, audio timing, marks and cards all hang on, and ebook2audiobook's output (M4B plus duration-summed sentence VTT, whole book at once) cannot carry our own stable IDs, word-level timing or progressive playback.
We still borrow its text cleaning and sentence-splitting rules.

## Considered Options

- **Wrap ebook2audiobook as a black-box worker**: rejected; batch-only, sentence-level timing only, heavy dependencies (Calibre, stanza), default XTTSv2 is non-commercial.
- **Cloud TTS (Azure, ElevenLabs, OpenAI)**: deferred; kept behind a replaceable TTS provider interface as possible premium voices.

## Consequences

- Kokoro is Apache-2.0 and returns word-level timestamps, so the cost per book is low enough to pre-render whole books.
