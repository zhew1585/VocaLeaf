import { useEffect, useState, type ReactNode } from "react";
import { getMe, logOut, UNAUTHORIZED_EVENT, type User } from "./api";
import { BookPage } from "./pages/BookPage";
import { ListenPage } from "./pages/ListenPage";
import { LoginPage } from "./pages/LoginPage";
import { UploadPage } from "./pages/UploadPage";
import { ListeningProvider } from "./player/session";
import { navigate, usePathname } from "./router";

/** /books/:id is the Book's detail, /books/:id/listen its 专注页, anything else the upload screen. */
function route(path: string): { bookId?: string; listen: boolean } {
  const [, bookId, listen] = /^\/books\/([^/]+)(\/listen)?$/.exec(path) ?? [];
  return { bookId, listen: listen !== undefined };
}

type Session = { state: "loading" } | { state: "failed" } | { state: "ready"; user: User | null };

/** Who is logged in on this device; drops to logged out whenever the API answers 401. */
function useSession() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  useEffect(() => {
    let active = true;
    getMe().then(
      (user) => active && setSession({ state: "ready", user }),
      () => active && setSession({ state: "failed" }),
    );
    const onUnauthorized = () => setSession({ state: "ready", user: null });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      active = false;
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);
  const setUser = (user: User | null) => setSession({ state: "ready", user });
  return { session, setUser };
}

/** Logged out, every path shows the login page; after login the same path opens, so a link survives logging in. */
export function App() {
  const path = usePathname();
  const { session, setUser } = useSession();
  const [loggingOut, setLoggingOut] = useState(false);

  if (session.state === "loading") return null;
  if (session.state === "failed") {
    return (
      <p className="form-error app-error" role="alert">
        网络连接失败，请刷新页面重试
      </p>
    );
  }
  if (!session.user) return <LoginPage onLoggedIn={setUser} />;

  async function onLogOut() {
    setLoggingOut(true);
    try {
      await logOut();
      navigate("/");
      setUser(null);
    } catch {
      // Still logged in; the button can be pressed again.
    } finally {
      setLoggingOut(false);
    }
  }

  const { bookId, listen } = route(path);
  // The listening session outlives the pages (【返回书架】 keeps playing) and ends with logging out.
  return (
    <ListeningProvider>
      {bookId && listen ? (
        // The 专注页 takes the whole window, without the app's header.
        <ListenPage id={bookId} />
      ) : (
        <Shell email={session.user.email} loggingOut={loggingOut} onLogOut={onLogOut}>
          {bookId ? <BookPage id={bookId} /> : <UploadPage />}
        </Shell>
      )}
    </ListeningProvider>
  );
}

/** The app's header (brand, account) above a page. */
function Shell({
  email,
  loggingOut,
  onLogOut,
  children,
}: {
  email: string;
  loggingOut: boolean;
  onLogOut(): void;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="brand">
        <a href="/" className="brand-name">拾页</a>
        <div className="account">
          <span className="account-email">{email}</span>
          <button type="button" className="text-button" disabled={loggingOut} onClick={onLogOut}>
            退出登录
          </button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
