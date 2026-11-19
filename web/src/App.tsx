import { useEffect, useState, type ReactNode } from "react";
import { getMe, logOut, UNAUTHORIZED_EVENT, type User } from "./api";
import logoUrl from "./assets/logo.webp";
import { PlayGuideProvider } from "./guide/PlayGuide";
import { LibraryIcon } from "./icons";
import { BookPage } from "./pages/BookPage";
import { ListenPage } from "./pages/ListenPage";
import { LoginPage } from "./pages/LoginPage";
import { NowListening } from "./player/NowListening";
import { ListeningProvider, useListening } from "./player/session";
import { followLink, navigate, usePathname } from "./router";
import { LibraryPage } from "./shelf/LibraryPage";
import { ShelfPage } from "./shelf/ShelfPage";

/** /books/:id is the Book's detail, /books/:id/listen its 专注页, /library the 书库, anything else the 书架. */
function route(path: string): { bookId?: string; listen: boolean; library: boolean } {
  const [, bookId, listen] = /^\/books\/([^/]+)(\/listen)?$/.exec(path) ?? [];
  return { bookId, listen: listen !== undefined, library: path === "/library" };
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

  const { bookId, listen, library } = route(path);
  // The listening session outlives the pages (【返回书架】 keeps playing) and ends with logging out.
  return (
    <PlayGuideProvider key={session.user.id} seen={session.user.playGuideSeen}>
      <ListeningProvider>
        {bookId && listen ? (
          // The 专注页 takes the whole window, without the app's header.
          <ListenPage id={bookId} />
        ) : (
          <Shell email={session.user.email} loggingOut={loggingOut} onLogOut={onLogOut}>
            {bookId ? <BookPage id={bookId} /> : library ? <LibraryPage /> : <ShelfPage />}
          </Shell>
        )}
      </ListeningProvider>
    </PlayGuideProvider>
  );
}

/**
 * The app around a page (design 03-2): the sidebar with the brand, the navigation, the 当前收听 entry while
 * there is a listening session, and the account; on a phone it becomes a bar above the page. 书架 is the only section so far; 拾起, 复习 and 卡片 join it with their tickets.
 */
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
  const listening = useListening();
  // Logging out ends the listening session (PRD G16): its progress is synced while the login still holds.
  const logOutHere = () => {
    listening.end();
    onLogOut();
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <a href="/" className="sidebar-brand" onClick={followLink}>
          <img src={logoUrl} alt="" width={36} height={36} />
          拾页
        </a>
        <nav className="sidebar-nav" aria-label="主导航">
          <a href="/" className="side-item is-active" onClick={followLink}>
            <LibraryIcon />
            书架
          </a>
        </nav>
        <NowListening />
        <div className="account">
          <span className="avatar" aria-hidden="true">
            {email.slice(0, 1).toUpperCase()}
          </span>
          <span className="account-email">{email}</span>
          <button type="button" className="text-button" disabled={loggingOut} onClick={logOutHere}>
            退出登录
          </button>
        </div>
      </aside>
      <main className="shell-main">{children}</main>
    </div>
  );
}
