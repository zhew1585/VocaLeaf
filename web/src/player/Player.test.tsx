import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audio, audioWithGenerated, hlsInstances, stubMediaPlayback, timeUpdate } from "../test-media";
import { Player, type PlayerProps } from "./Player";
import { formatElapsed, formatRemaining } from "./Progress";
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

    const bar = screen.getByRole("slider", { name: "整本进度" });
    expect(bar.getAttribute("aria-valuenow")).toBe("252");
    expect(bar.getAttribute("aria-valuemax")).toBe("41752");
    expect(screen.getByText("0:04:12")).toBeTruthy();
    expect(screen.getByText("−11:31:40")).toBeTruthy();
  });

  it("uses what is seekable as the length while the Book is still generating", () => {
    renderPlayer();
    Object.defineProperty(audio(), "seekable", { value: { length: 1, end: () => 120 }, configurable: true });

    timeUpdate(30);

    expect(screen.getByRole("slider").getAttribute("aria-valuemax")).toBe("120");
    expect(screen.getByText("−0:01:30")).toBeTruthy();
  });

  it("measures progress against the whole Book's length when it is known", () => {
    renderPlayer({ totalSeconds: 41_752 });

    timeUpdate(252, 600); // only 10 minutes are generated so far

    expect(screen.getByRole("slider").getAttribute("aria-valuemax")).toBe("41752");
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

describe("Player controls (design 01 ④)", () => {
  it("lays out speed, sleep timer, 重听, play / pause and 下一句 from left to right", () => {
    renderPlayer();
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["倍速 1.0×", "睡眠定时", "重听", "播放", "下一句"]);
  });

  it("picks a speed from the menu above the button", () => {
    renderPlayer();
    fireEvent.click(screen.getByRole("button", { name: "倍速 1.0×" }));
    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((o) => o.textContent)).toEqual(["0.5×", "0.75×", "1.0×", "1.25×", "1.5×", "1.75×", "2.0×"]);
    expect(options[2]!.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "1.5×" }));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "倍速 1.5×" })).toBeTruthy();
    expect(audio().playbackRate).toBe(1.5);
  });

  it("sets the sleep timer, shows the time left when opened again, and turns it off", () => {
    renderPlayer();
    const moon = () => screen.getByRole("button", { name: "睡眠定时" });
    fireEvent.click(moon());
    expect(screen.getAllByRole("menuitemradio").map((o) => o.textContent)).toEqual([
      "15 分钟",
      "30 分钟",
      "45 分钟",
      "60 分钟",
      "本章结束",
    ]);
    expect(screen.queryByRole("menuitem", { name: "关闭定时" })).toBeNull();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "30 分钟" }));
    expect(moon().className).toContain("active");

    fireEvent.click(moon());
    expect(screen.getByRole("menu").textContent).toMatch(/睡眠定时(30:00|29:59)/);
    expect(screen.getByRole("menuitemradio", { name: "30 分钟" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("menuitem", { name: "关闭定时" }));
    expect(moon().className).not.toContain("active");
  });

  it("closes a menu on a press outside it and on Esc", () => {
    renderPlayer();
    fireEvent.click(screen.getByRole("button", { name: "睡眠定时" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "睡眠定时" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("follows the pointer while the bar is dragged and seeks where it is released (AC-PLAY-21)", () => {
    renderPlayer();
    const { seeks } = audioWithGenerated(1000);
    const bar = screen.getByRole("slider", { name: "整本进度" });
    bar.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect;

    fireEvent.pointerDown(bar, { clientX: 150, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 200, pointerId: 1 });
    expect(bar.getAttribute("aria-valuenow")).toBe("500");
    expect(screen.getByText("0:08:20")).toBeTruthy();
    expect(seeks).toEqual([]);

    fireEvent.pointerUp(bar, { clientX: 201, pointerId: 1 });
    expect(seeks).toEqual([505]);
  });

  it("says when the network is down", () => {
    renderPlayer();
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status").textContent).toBe("网络已断开，恢复后继续播放");
  });
});

describe("time formats", () => {
  it("writes hours, minutes and seconds, and a minus sign for time left", () => {
    expect(formatElapsed(0)).toBe("0:00:00");
    expect(formatElapsed(3_725.9)).toBe("1:02:05");
    expect(formatRemaining(41_500)).toBe("−11:31:40");
  });
});
