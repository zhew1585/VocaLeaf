import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audio, hlsInstances, stubMediaPlayback, timeUpdate } from "../test-media";
import { formatElapsed, formatRemaining, Player } from "./Player";
import { ListeningProvider, useListening } from "./session";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hlsInstances.length = 0;
  ({ play, pause } = stubMediaPlayback());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A player for Book b1's session, as the 专注页 opens it. */
function OpenedPlayer({ id = "b1", totalSeconds }: { id?: string; totalSeconds?: number }) {
  const { open } = useListening();
  useEffect(() => open(id), [open, id]);
  return <Player totalSeconds={totalSeconds} />;
}

function renderPlayer(props: { id?: string; totalSeconds?: number } = {}) {
  return render(
    <ListeningProvider>
      <OpenedPlayer {...props} />
    </ListeningProvider>,
  );
}

describe("Player", () => {
  it("loads the Book's HLS playlist from the beginning, not from the live edge", () => {
    renderPlayer();

    expect(hlsInstances.map((h) => h.source)).toEqual(["/api/books/b1/audio.m3u8"]);
    expect(hlsInstances[0]!.media).toBe(audio());
    expect(hlsInstances[0]!.config).toMatchObject({ startPosition: 0 });
  });

  it("plays and pauses with the one button, which says what it will do", () => {
    renderPlayer();

    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(play).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
  });

  it("shows how far into the whole Book playback is, with time listened and time left", () => {
    renderPlayer();

    timeUpdate(252, 41_752);

    const bar = screen.getByRole("progressbar", { name: "整本进度" });
    expect(bar.getAttribute("aria-valuenow")).toBe("252");
    expect(bar.getAttribute("aria-valuemax")).toBe("41752");
    expect(screen.getByText("0:04:12")).toBeTruthy();
    expect(screen.getByText("−11:31:40")).toBeTruthy();
  });

  it("uses what is seekable as the length while the Book is still generating", () => {
    renderPlayer();
    Object.defineProperty(audio(), "seekable", { value: { length: 1, end: () => 120 }, configurable: true });

    timeUpdate(30, Number.POSITIVE_INFINITY);

    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("120");
    expect(screen.getByText("−0:01:30")).toBeTruthy();
  });

  it("measures progress against the whole Book's length when it is known", () => {
    renderPlayer({ totalSeconds: 41_752 });

    timeUpdate(252, 600); // only 10 minutes are generated so far

    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("41752");
    expect(screen.getByText("−11:31:40")).toBeTruthy();
  });

  it("says so when the stream cannot be played, but not for errors hls.js recovers from", () => {
    renderPlayer();
    const onError = hlsInstances[0]!.handlers.hlsError!;

    act(() => onError("hlsError", { fatal: false }));
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => onError("hlsError", { fatal: true }));
    expect(screen.getByRole("alert").textContent).toBe("播放失败，请刷新页面重试");
  });

  it("stops loading when it goes away", () => {
    const { unmount } = renderPlayer();
    unmount();
    expect(hlsInstances[0]!.destroyed).toBe(true);
  });
});

describe("time formats", () => {
  it("writes hours, minutes and seconds, and a minus sign for time left", () => {
    expect(formatElapsed(0)).toBe("0:00:00");
    expect(formatElapsed(3_725.9)).toBe("1:02:05");
    expect(formatRemaining(41_500)).toBe("−11:31:40");
  });
});
