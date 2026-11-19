# VocaLeaf（拾页）

A listening-first app that turns a user's own English ebook into an audiobook for background listening, with lightweight capture of words and sentences to study later.
Listening is the primary job; English learning is a secondary loop built on top of what the user captured while listening.

## Language

**Book**:
An ebook's parsed text and its generated audio, either uploaded by a user or provided by the Library.
_Avoid_: Document, file, title

**Library**:
The curated set of public-domain Books provided by VocaLeaf, with audio shared by all users.
_Avoid_: Store, catalog, bookstore

**Shelf**:
One user's own collection of Books: those they uploaded and those they added from the Library.
_Avoid_: My books, collection, bookcase

**Voice**:
The narrator a Book's audio is generated with, chosen from a small curated set (US/UK, male/female); changing it regenerates the Book's audio.
_Avoid_: Speaker, narrator, TTS model

Marks, Explanations, Cards and listening progress always belong to one user, even when the Book comes from the Library.
An uploaded Book and its audio are never shared with other users.

**Chapter**:
A top-level section of a Book as listed in its table of contents; a Chapter is either narrated or Skipped.
_Avoid_: Section, part, spine item

**Skipped**:
The state of a Chapter that is kept in the Book but not narrated, such as a copyright page or index; detected automatically and changeable by the user.
_Avoid_: Hidden, excluded, front matter

**Sentence**:
The smallest unit of a Book's text, with a stable ID; the anchor that audio timing, marks and cards attach to.
_Avoid_: Segment, line, chunk

An HLS segment (about ten seconds of a Chapter's audio, cut without regard to Sentences) is a storage and playback detail, not a domain term; never call a Sentence a segment.

**Listening session**:
The one Book being listened to on a device, with its playback position; it goes on while the user leaves the 专注页 and ends with opening another Book or logging out.
_Avoid_: Player (the controls), playback queue

## Capture

**Mark**:
A Sentence the user deliberately flagged while listening, to study later.
_Avoid_: Highlight, bookmark, annotation, note

Jumping back with ⏮ only replays audio; it records nothing and never creates a Mark.

**Gleanings** (拾起):
The cross-book queue of unprocessed Marks waiting to be turned into Cards or dismissed.
_Avoid_: Inbox, queue, backlog, basket

**Dismiss**:
Removing a Mark from Gleanings without making a Card.
_Avoid_: Delete, archive, ignore

## Study

**Card**:
A study item made from one Sentence and one Target within it, explained in that Sentence's context and replayed with that Sentence's own audio.
A Card keeps its own copy of the Sentence text and audio, so it outlives its Book and any Voice change.
Two Cards may share the same Target from different Sentences; they are never merged.
_Avoid_: Flashcard, word card, vocabulary entry

**Target**:
The span of a Sentence a Card teaches: a word, a phrase, or the whole Sentence.
_Avoid_: Word, selection, keyword

**Explanation**:
An AI-generated Chinese breakdown of one Sentence (meaning, grammar, phrases, background), kept on that Sentence together with the user's follow-up questions and answers.
_Avoid_: Analysis, AI note, translation

**Review**:
A session in which the user works through Cards that are due today, scheduled by spaced repetition.
_Avoid_: Practice, quiz, study session
