import { useEffect, useState } from "react";
import { getMe, logOut, UNAUTHORIZED_EVENT, type User } from "./api";
import { BookPage } from "./pages/BookPage";
import { ListenPage } from "./pages/ListenPage";
import { LoginPage } from "./pages/LoginPage";
import { UploadPage } from "./pages/UploadPage";
import { navigate, usePathname } from "./router";

/** /books/:id is the Book's detail, /books/:id/listen its 专注页, anything else the upload screen. */
function Screen({ path }: { path: string }) {
  const [, bookId, listen] = /^\/books\/([^/]+)(\/listen)?$/.exec(path) ?? [];
  if (!bookId) return <UploadPage />;
  return listen ? <ListenPage id={bookId} /> : <BookPage id={bookId} />;
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

  return (
    <div className="shell">
      <header className="brand">
        <a href="/" className="brand-name">拾页</a>
        <div className="account">
          <span className="account-email">{session.user.email}</span>
          <button type="button" className="text-button" disabled={loggingOut} onClick={onLogOut}>
            退出登录
          </button>
        </div>
      </header>
      <main>
        <Screen path={path} />
      </main>
    </div>
  );
}
