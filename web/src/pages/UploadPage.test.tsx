import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadPage } from "./UploadPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState(null, "", "/");
});

const epub = () => new File(["PK"], "pride-and-prejudice.epub", { type: "application/epub+zip" });

function chooseFile(file: File) {
  fireEvent.change(screen.getByLabelText("选择 EPUB 文件"), { target: { files: [file] } });
}

describe("UploadPage", () => {
  it("enables 上传 only after a file is chosen, and shows its name", () => {
    render(<UploadPage />);
    expect(screen.getByRole("button", { name: "上传" })).toBeDisabled();

    chooseFile(epub());

    expect(screen.getByText("pride-and-prejudice.epub")).toBeTruthy();
    expect(screen.getByRole("button", { name: "上传" })).toBeEnabled();
  });

  it("uploads the file and opens the new Book's detail page", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "b1", title: "x", author: null, status: "parsing" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<UploadPage />);

    chooseFile(epub());
    fireEvent.click(screen.getByRole("button", { name: "上传" }));

    await waitFor(() => expect(window.location.pathname).toBe("/books/b1"));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/books");
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("shows the API's error message and stays on the page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { code: "unsupported_format", message: "目前只支持 EPUB 格式" } }, { status: 400 }),
      ),
    );
    render(<UploadPage />);

    chooseFile(new File(["x"], "notes.pdf"));
    fireEvent.click(screen.getByRole("button", { name: "上传" }));

    expect(await screen.findByText("目前只支持 EPUB 格式")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });
});
