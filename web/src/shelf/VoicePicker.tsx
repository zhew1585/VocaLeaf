import { useEffect, useRef, useState } from "react";
import type { Voice } from "../api";
import { SquareSolidIcon, Volume2Icon } from "../icons";
import { previewUrl, VOICES } from "../voices";

/**
 * Plays one Voice's 5-second preview at a time on its own audio element (never the listening session's): playing
 * another stops the first, and pressing the playing one again stops it. Stops when the component goes away.
 */
function useVoicePreview() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<Voice | null>(null);

  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );

  const stop = () => {
    audio.current?.pause();
    setPlaying(null);
  };

  const toggle = (voice: Voice) => {
    if (playing === voice) return stop();
    audio.current?.pause();
    const el = new Audio(previewUrl(voice));
    el.onended = () => setPlaying((v) => (v === voice ? null : v));
    audio.current = el;
    setPlaying(voice);
    el.play().catch((err: unknown) => {
      // A preview that will not play (offline, a codec) only leaves the button as it was.
      console.warn(`playing the preview of ${voice} failed`, err);
      setPlaying((v) => (v === voice ? null : v));
    });
  };

  return { playing, toggle };
}

/**
 * 音色 in the upload dialog (design 04-1): the four Voices to pick from, each with a 试听 button that plays its
 * 5-second preview (PRD 4.2.4, F4).
 */
export function VoicePicker({ value, disabled, onChange }: { value: Voice; disabled: boolean; onChange(voice: Voice): void }) {
  const preview = useVoicePreview();
  return (
    <fieldset className="voice-field" disabled={disabled}>
      <legend className="voice-legend">音色</legend>
      <div className="voice-options">
        {VOICES.map(({ id, name }) => {
          const playing = preview.playing === id;
          return (
            <div key={id} className={`voice-option${value === id ? " is-selected" : ""}`}>
              <button
                type="button"
                className="voice-preview"
                aria-label={playing ? `停止试听${name}` : `试听${name}`}
                aria-pressed={playing}
                onClick={() => preview.toggle(id)}
              >
                <span key={playing ? "stop" : "play"} className="icon-swap">
                  {playing ? <SquareSolidIcon /> : <Volume2Icon size={13} />}
                </span>
              </button>
              <label className="voice-name">
                <input type="radio" name="voice" value={id} checked={value === id} onChange={() => onChange(id)} />
                {name}
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
