import { BookPage } from "./pages/BookPage";
import { UploadPage } from "./pages/UploadPage";
import { usePathname } from "./router";

export function App() {
  const path = usePathname();
  const bookId = /^\/books\/([^/]+)$/.exec(path)?.[1];
  return (
    <div className="shell">
      <header className="brand">
        <a href="/" className="brand-name">拾页</a>
      </header>
      <main>{bookId ? <BookPage id={bookId} /> : <UploadPage />}</main>
    </div>
  );
}
