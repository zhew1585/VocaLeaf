import { getBook, type Book } from "../api";
import { useListening } from "../player/session";

// Each start from the Shelf is a new request, so starting the same Book again starts again.
let starts = 0;

/**
 * Plays or pauses a Book from the Shelf without leaving it, through the one listening session, so every control
 * (【继续收听】, a cover's 播放, the sidebar's 当前收听) shows the same state.
 * Playing starts at the Book's last Sentence as the API has it now, like opening it from the Shelf (AC-PLAY-05):
 * another device may have listened on since the Shelf loaded.
 */
export function useShelfPlay(book: Book): { playing: boolean; toggle(): void } {
  const listening = useListening();
  const playing = listening.bookId === book.id && listening.playing;

  const start = async () => {
    const latest = await getBook(book.id).catch((err: unknown) => {
      console.warn("loading the Book before playing it failed; playing from the Shelf's copy", err);
      return null;
    });
    const startMs = (latest ?? book).listening?.startMs ?? 0;
    listening.open(book.id, latest?.voice);
    listening.requestStart({ id: `shelf#${++starts}`, seconds: startMs / 1000, autoplay: true });
  };

  return { playing, toggle: () => (playing ? listening.toggle() : void start()) };
}
