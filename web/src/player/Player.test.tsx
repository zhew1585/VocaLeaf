import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audio, audioWithGenerated, hlsInstances, stubMediaPlayback, timeUpdate } from "../test-media";
import { formatElapsed, formatRemaining, Player, type PlayerProps } from "./Player";
import { ListeningProvider, useListening } from "./session";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

let media: ReturnType<typeof stubMediaPlayback>;
beforeEach(() => {
  hlsInstances.length = 0;
  media = stubMediaPlayback();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The player on a session with Book b1 open, as the 专注页 has it. */
function OpenedPlayer(props: PlayerProps & { startAt?: { id: string; seconds: number } }) {
  const { open, requestStart } = useListening();
  useEffect(() => {
    open("b1");
    if (props.startAt) requestStart({ ...props.startAt, autoplay: true });
  }, [open, requestStart]);
  return <Player {...props} />;
}

function renderPlayer(props: Parameters<typeof OpenedPlayer>[0] = {}) {
  return render(
    <ListeningProvider>
      <OpenedPlayer {...props} />
    </ListeningProvider>,
  );
}

describe("Player", () => {
  it("plays the session's Book with the one button, which says what it will do", () => {
    renderPlayer();
    expect(hlsInstances[0]!.media).toBe(audio());

    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(media.play).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(media.pause).toHaveBeenCalledTimes(1);
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

    timeUpdate(30);

    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("120");
    expect(screen.getByText("−0:01:30")).toBeTruthy();
  });

  it("measures progress against the whole Book's length when it is known", () => {
    renderPlayer({ totalSeconds: 41_752 });

    timeUpdate(252, 600); // only 10 minutes are generated so far

    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("41752");
    expect(screen.getByText("−11:31:40")).toBeTruthy();
  });

  it("says so when the stream cannot be played", () => {
    renderPlayer();
    act(() => hlsInstances[0]!.handlers.hlsError!("hlsError", { fatal: true }));
    expect(screen.getByRole("alert").textContent).toBe("播放失败，请刷新页面重试");
  });

  it("shows a notice above the controls", () => {
    renderPlayer({ notice: "该章节生成中，预计约 40 秒" });
    expect(screen.getByRole("status").textContent).toBe("该章节生成中，预计约 40 秒");
  });

  it("asks for a tap when the browser does not let a picked Chapter start on its own", async () => {
    media.play.mockImplementationOnce(() => Promise.reject(new DOMException("autoplay", "NotAllowedError")));
    renderPlayer({ startAt: { id: "c3", seconds: 10 }, notice: "该章节生成中，预计约 40 秒" });
    audioWithGenerated(60);
    await act(async () => {});

    expect(screen.getByRole("status").textContent).toBe("已可以收听，点播放开始");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
  });
});

describe("time formats", () => {
  it("writes hours, minutes and seconds, and a minus sign for time left", () => {
    expect(formatElapsed(0)).toBe("0:00:00");
    expect(formatElapsed(3_725.9)).toBe("1:02:05");
    expect(formatRemaining(41_500)).toBe("−11:31:40");
  });
});
