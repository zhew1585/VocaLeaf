import { BookPage } from "./pages/BookPage";
import { ListenPage } from "./pages/ListenPage";
import { UploadPage } from "./pages/UploadPage";
import { PlaybackProvider } from "./player/playback";
import { usePathname } from "./router";

/**
 * /books/:id is the Book's detail, /books/:id/listen its 专注页, anything else the upload screen.
 * The 专注页 takes the whole window and hides the global navigation (F7); playback outlives every screen.
 */
export function App() {
  const path = usePathname();
  const [, bookId, listen] = /^\/books\/([^/]+)(\/listen)?$/.exec(path) ?? [];

  return (
    <PlaybackProvider>
      {bookId && listen ? (
        <ListenPage key={bookId} id={bookId} />
      ) : (
        <div className="shell">
          <header className="brand">
            <a href="/" className="brand-name">拾页</a>
          </header>
          <main>{bookId ? <BookPage id={bookId} /> : <UploadPage />}</main>
        </div>
      )}
    </PlaybackProvider>
  );
}
