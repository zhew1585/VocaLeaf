import { BookPage } from "./pages/BookPage";
import { ListenPage } from "./pages/ListenPage";
import { UploadPage } from "./pages/UploadPage";
import { usePathname } from "./router";

/** /books/:id is the Book's detail, /books/:id/listen its 专注页, anything else the upload screen. */
function Screen({ path }: { path: string }) {
  const [, bookId, listen] = /^\/books\/([^/]+)(\/listen)?$/.exec(path) ?? [];
  if (!bookId) return <UploadPage />;
  return listen ? <ListenPage id={bookId} /> : <BookPage id={bookId} />;
}

export function App() {
  const path = usePathname();
  return (
    <div className="shell">
      <header className="brand">
        <a href="/" className="brand-name">拾页</a>
      </header>
      <main>
        <Screen path={path} />
      </main>
    </div>
  );
}
