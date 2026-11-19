import Hls from "hls.js";
import { useEffect, useRef, type RefObject } from "react";

/**
 * Attaches the Book's HLS playlist to the audio element: hls.js where Media Source is available, the browser's
 * own HLS (Safari on iOS) otherwise. The playlist is an EVENT playlist while the Book is generating, which
 * hls.js would otherwise start at the live edge; listening always starts at the Book's beginning. A new
 * `reloads` loads it again. `onFatal` hears of an error hls.js gave up on; `restart` makes it load again (after
 * the network came back).
 */
export function useHls(audio: RefObject<HTMLAudioElement | null>, src: string | null, reloads: number, onFatal: () => void) {
  const instance = useRef<Hls | null>(null);
  useEffect(() => {
    const el = audio.current!;
    if (src === null) return;
    if (!Hls.isSupported()) {
      el.src = src;
      return () => {
        el.removeAttribute("src");
        el.load();
      };
    }
    const hls = new Hls({ startPosition: 0 });
    instance.current = hls;
    // hls.js retries network and media errors itself; a fatal one means playback cannot go on.
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) onFatal();
    });
    hls.loadSource(src);
    hls.attachMedia(el);
    return () => {
      instance.current = null;
      hls.destroy();
    };
    // onFatal only reports; a new function each render must not reload the stream.
  }, [audio, src, reloads]);

  return {
    // Without a position hls.js resumes loading where the element is.
    restart: () => instance.current?.startLoad(),
  };
}
