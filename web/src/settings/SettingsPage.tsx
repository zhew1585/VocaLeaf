import { useEffect, useState } from "react";
import { getUsage, type Usage } from "../api";
import { usePlayGuide } from "../guide/PlayGuide";
import { ChevronRightIcon, InfoIcon, KeyboardIcon, LogOutIcon } from "../icons";
import { useListening } from "../player/session";
import { PLAYER_SHORTCUTS } from "../player/shortcuts";
import "./settings.css";

/** Desktop shortcuts as the page lists them (design 08-1): the 专注页's, then the 复习页's (PRD F13, #16). */
const SHORTCUTS: readonly { name: string; keys: readonly string[] }[] = [
  ...PLAYER_SHORTCUTS,
  { name: "显示答案", keys: ["空格"] },
  { name: "评分", keys: ["1", "2", "3", "4"] },
];

/** The user's quotas from the API, loaded once per visit. */
function useUsage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    getUsage().then(
      (loaded) => active && setUsage(loaded),
      (err: unknown) => active && setError(err instanceof Error ? err.message : "加载失败，请稍后再试"),
    );
    return () => {
      active = false;
    };
  }, []);
  return { usage, error };
}

/** One quota card: the value over its limit, and a bar filled by `value / max`. Shows "–" while loading. */
function Meter({ label, value, max, valueText }: { label: string; value?: number; max?: number; valueText?: string }) {
  const known = value !== undefined && max !== undefined;
  const share = known ? Math.min(1, value / max) : 0;
  return (
    <div
      className="settings-card meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
    >
      <span className="meter-label">{label}</span>
      <span className="meter-value">
        <span className="meter-number">{known ? value : "–"}</span>
        {known && <span className="meter-unit">/ {max}</span>}
      </span>
      <span className="meter-track" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${share * 100}%` }} />
      </span>
    </div>
  );
}

/**
 * 设置 (design 08-1, PRD F15): the account with 【退出登录】, today's AI calls left and the uploaded Books held
 * (PRD 4.7.2), 【操作说明】 to see the first-play guide again, and the desktop shortcuts.
 */
export function SettingsPage({
  email,
  loggingOut,
  onLogOut,
}: {
  email: string;
  loggingOut: boolean;
  /** Ends this device's session and shows the login page. */
  onLogOut(): void;
}) {
  const { usage, error } = useUsage();
  const guide = usePlayGuide();
  const listening = useListening();
  // Logging out ends the listening session (PRD G16): its progress is synced while the login still holds.
  const logOut = () => {
    listening.end();
    onLogOut();
  };

  return (
    <div className="settings">
      <h1 className="settings-title">设置</h1>
      <div className="settings-columns">
        <section className="settings-column" aria-label="账号">
          <div className="settings-account">
            <span className="avatar is-large" aria-hidden="true">
              {email.slice(0, 1).toUpperCase()}
            </span>
            <span className="settings-account-text">
              <span className="settings-email">{email}</span>
              <span className="settings-role">内测用户</span>
            </span>
            <button type="button" className="sign-out" disabled={loggingOut} onClick={logOut}>
              <LogOutIcon />
              退出登录
            </button>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="settings-meters">
            <Meter
              label="今日剩余解析"
              value={usage?.aiRemaining}
              max={usage?.aiDailyLimit}
              valueText={usage ? `剩余 ${usage.aiRemaining} 次` : undefined}
            />
            <Meter
              label="上传书籍"
              value={usage?.uploadedBooks}
              max={usage?.maxUploadedBooks}
              valueText={usage ? `${usage.uploadedBooks} / ${usage.maxUploadedBooks}` : undefined}
            />
          </div>
          <button type="button" className="settings-card guide-link" onClick={() => guide.show()}>
            <InfoIcon />
            <span className="guide-link-label">操作说明</span>
            <ChevronRightIcon />
          </button>
        </section>
        <section className="settings-column" aria-labelledby="shortcuts-title">
          <h2 id="shortcuts-title" className="settings-section-title">
            <KeyboardIcon />
            快捷键
          </h2>
          <ul className="settings-card shortcuts" aria-labelledby="shortcuts-title">
            {SHORTCUTS.map(({ name, keys }) => (
              <li key={name} className="shortcut">
                <span className="shortcut-name">{name}</span>
                <span className="shortcut-keys">
                  {keys.map((key) => (
                    <kbd key={key} className="key">
                      {key}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
