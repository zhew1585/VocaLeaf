import { useEffect, useState, type ReactNode } from "react";
import { getMe, logOut, UNAUTHORIZED_EVENT, type User } from "./api";
import { resetSentenceChats } from "./reading/chatStore";
import logoUrl from "./assets/logo.webp";
import { PlayGuideProvider } from "./guide/PlayGuide";
import { LeafIcon, LibraryIcon, SettingsIcon } from "./icons";
import { GleaningsPage } from "./marks/GleaningsPage";
import { startOutbox, stopOutbox } from "./marks/marks";
import { badgeText, useGleaningCount } from "./marks/useMarks";
import { BookPage } from "./pages/BookPage";
import { ListenPage } from "./pages/ListenPage";
import { LoginPage } from "./pages/LoginPage";
import { NowListening } from "./player/NowListening";
import { ListeningProvider } from "./player/session";
import { followLink, navigate, usePathname } from "./router";
import { SettingsPage } from "./settings/SettingsPage";
import { LibraryPage } from "./shelf/LibraryPage";
import { ShelfPage } from "./shelf/ShelfPage";

/**
 * /books/:id is the Book's detail, /books/:id/listen its 专注页, /library the 书库, /gleanings 拾起, /settings 设置,
 * anything else the 书架.
 */
function route(path: string): { bookId?: string; listen: boolean; library: boolean; gleanings: boolean; settings: boolean } {
  const [, bookId, listen] = /^\/books\/([^/]+)(\/listen)?$/.exec(path) ?? [];
  return {
    bookId,
    listen: listen !== undefined,
    library: path === "/library",
    gleanings: path === "/gleanings",
    settings: path === "/settings",
  };
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
  // Explanations are private to a user: none stay in memory for whoever logs in next on this device.
  const loggedOut = session.state === "ready" && session.user === null;
  useEffect(() => {
    if (loggedOut) resetSentenceChats();
  }, [loggedOut]);
  return { session, setUser };
}

/** Logged out, every path shows the login page; after login the same path opens, so a link survives logging in. */
export function App() {
  const path = usePathname();
  const { session, setUser } = useSession();
  const [loggingOut, setLoggingOut] = useState(false);
  const userId = session.state === "ready" ? (session.user?.id ?? null) : null;
  // The logged-in user's Marks made offline (also on an earlier visit) go out once the network allows (PRD F8).
  useEffect(() => {
    if (userId === null) return;
    startOutbox(userId);
    return stopOutbox;
  }, [userId]);

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

  const { bookId, listen, library, gleanings, settings } = route(path);
  const { email } = session.user;
  // The listening session outlives the pages (【返回书架】 keeps playing) and ends with logging out.
  return (
    <PlayGuideProvider key={session.user.id} seen={session.user.playGuideSeen}>
      <ListeningProvider>
        {bookId && listen ? (
          // The 专注页 takes the whole window, without the app's header.
          <ListenPage id={bookId} />
        ) : (
          <Shell email={email} section={gleanings ? "gleanings" : settings ? "settings" : "shelf"}>
            {bookId ? (
              <BookPage id={bookId} />
            ) : library ? (
              <LibraryPage />
            ) : gleanings ? (
              <GleaningsPage />
            ) : settings ? (
              <SettingsPage email={email} loggingOut={loggingOut} onLogOut={onLogOut} />
            ) : (
              <ShelfPage />
            )}
          </Shell>
        )}
      </ListeningProvider>
    </PlayGuideProvider>
  );
}

/**
 * The app around a page (design 03-2): the sidebar with the brand, the navigation, the 当前收听 entry while
 * there is a listening session, and the account, which opens 设置 (design 08-1); on a phone it becomes a bar above
 * the page. 书架 and 拾起 so far; 复习 and 卡片 join them with their tickets. 拾起 shows how many Sentences wait
 * there (PRD 4.4.4 计数).
 */
function Shell({
  email,
  section,
  children,
}: {
  email: string;
  /** The navigation entry of the page shown; the account entry stands for 设置. */
  section: "shelf" | "gleanings" | "settings";
  children: ReactNode;
}) {
  const badge = badgeText(useGleaningCount());
  const item = (name: typeof section) => ({
    className: section === name ? "side-item is-active" : "side-item",
    "aria-current": section === name ? ("page" as const) : undefined,
    onClick: followLink,
  });
  return (
    <div className="shell">
      <aside className="sidebar">
        <a href="/" className="sidebar-brand" onClick={followLink}>
          <img src={logoUrl} alt="" width={36} height={36} />
          拾页
        </a>
        <nav className="sidebar-nav" aria-label="主导航">
          <a href="/" {...item("shelf")}>
            <LibraryIcon />
            书架
          </a>
          <a href="/gleanings" {...item("gleanings")}>
            <LeafIcon size={20} />
            拾起
            {badge && <span className="side-badge">{badge}</span>}
          </a>
        </nav>
        <NowListening />
        <a href="/settings" aria-label="设置" title="设置" {...item("settings")} className="account">
          <span className="avatar" aria-hidden="true">
            {email.slice(0, 1).toUpperCase()}
          </span>
          <span className="account-email">{email}</span>
          <SettingsIcon />
        </a>
      </aside>
      <main className={section === "gleanings" ? "shell-main is-flush" : "shell-main"}>{children}</main>
    </div>
  );
}
