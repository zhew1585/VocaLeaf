import { describe, expect, it } from "vitest";
import type { UploadPolicy } from "../api";
import { uploadRefusal } from "./uploadCheck";

const MB = 1024 * 1024;
const policy: UploadPolicy = {
  maxFileBytes: 50 * MB,
  maxBooks: 20,
  uploadedBooks: 3,
  declaration: { version: "1", text: "我确认", accepted: false },
};
/** A file that reports `size` bytes without holding them. */
function file(name: string, size = 10) {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("uploadRefusal", () => {
  it("accepts an EPUB within the limits, whatever the extension's case", () => {
    expect(uploadRefusal(file("book.epub"), policy)).toBeNull();
    expect(uploadRefusal(file("BOOK.EPUB", 50 * MB), policy)).toBeNull();
  });

  it.each(["notes.pdf", "notes.txt", "book.epub.zip", "epub"])("AC-UP-01: refuses %s", (name) => {
    expect(uploadRefusal(file(name), policy)).toBe("目前只支持 EPUB 格式");
  });

  it("AC-UP-02: refuses an EPUB over 50MB", () => {
    expect(uploadRefusal(file("big.epub", 60 * MB), policy)).toBe("文件不能超过 50MB");
  });

  it("AC-UP-03: refuses any upload once the user holds 20 uploaded Books", () => {
    expect(uploadRefusal(file("one-more.epub"), { ...policy, uploadedBooks: 20 })).toBe(
      "内测期最多上传 20 本书，可删除不再听的书后再上传",
    );
  });

  it("checks format, then size, then the quota (PRD 4.3.2)", () => {
    const full = { ...policy, uploadedBooks: 20 };
    expect(uploadRefusal(file("big.pdf", 60 * MB), full)).toBe("目前只支持 EPUB 格式");
    expect(uploadRefusal(file("big.epub", 60 * MB), full)).toBe("文件不能超过 50MB");
  });
});
