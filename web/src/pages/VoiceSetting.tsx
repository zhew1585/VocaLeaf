import { useEffect, useRef, useState } from "react";
import { changeVoice, type BookDetail, type Voice } from "../api";
import { CheckIcon, ChevronDownIcon, MicVocalIcon } from "../icons";
import { usePresence } from "../motion";
import { isWorking } from "../useBook";
import { voiceName, VOICES } from "../voices";

/** Why the Voice cannot be changed now, as the button's tooltip; null when it can. */
function lockedReason(book: BookDetail): string | null {
  if (book.voiceChange?.status === "running") return "正在更换音色，完成前不能再次更换";
  // Until all of its audio is there to replace, a retried Chapter included (the API refuses it too).
  if (isWorking(book)) return "这本书生成完成后才能更换音色";
  return null;
}

/**
 * The Book's Voice under 开始收听 (design 04-2, PRD 4.2.4, F5 更换音色): a menu of the four Voices. Picking another
 * starts generating the Book again in it; the old Voice plays until the new audio is complete, which the page
 * shows (正在更换为 {音色}，完成前仍使用原音色) and keeps polling for (useBook). A failed change says the old
 * Voice was kept. Not shown for a Library Book, which keeps its Voice (PRD 4.2.2).
 */
export function VoiceSetting({ book, onChanged }: { book: BookDetail; onChanged(): void }) {
  const [open, setOpen] = useState(false);
  const menu = usePresence(open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!book.voiceChangeable) return null;
  const locked = lockedReason(book);

  async function pick(voice: Voice) {
    setOpen(false);
    if (voice === book.voice) return;
    setBusy(true);
    setError(null);
    try {
      await changeVoice(book.id, voice);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更换音色失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={root} className="voice-setting">
      <button
        type="button"
        className="voice-button"
        aria-label={`音色：${voiceName(book.voice)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={locked !== null || busy}
        title={locked ?? undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="voice-button-label">
          <MicVocalIcon />
          {voiceName(book.voice)}
        </span>
        <ChevronDownIcon size={16} />
      </button>
      {menu.value && (
        <div className={menu.exiting ? "voice-menu is-exiting" : "voice-menu"} role="menu" aria-label="更换音色">
          {VOICES.map(({ id, name }) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={id === book.voice}
              className={id === book.voice ? "player-option checked" : "player-option"}
              onClick={() => void pick(id)}
            >
              {name}
              {id === book.voice && <CheckIcon size={16} />}
            </button>
          ))}
        </div>
      )}
      {book.voiceChange?.status === "running" && (
        <p className="voice-note" role="status">
          正在更换为 {voiceName(book.voiceChange.to)}，完成前仍使用原音色
        </p>
      )}
      {book.voiceChange?.status === "failed" && !error && <p className="form-error">音色更换失败，已保留原音色</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
