import { useRef, useState, type DragEvent } from "react";
import { uploadBook } from "../api";
import { UploadIcon } from "../icons";
import { navigate } from "../router";

/** Upload screen, design 04-1 (file picker and 上传 button only; voice and declaration come later). */
export function UploadPage() {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  function choose(next: File | undefined) {
    setFile(next ?? null);
    setError(null);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer.files[0]);
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const book = await uploadBook(file);
      navigate(`/books/${book.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败，请稍后再试");
      setBusy(false);
    }
  }

  return (
    <section className="upload-card">
      <h1 className="upload-title">上传书籍</h1>
      <button
        type="button"
        className={`dropzone${dragging ? " is-dragging" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <span className="dropzone-icon">
          <UploadIcon />
        </span>
        <span className="dropzone-label">{file ? file.name : "拖入 EPUB，或点击选择"}</span>
        <span className="dropzone-hint">{file ? "点击可重新选择" : "支持无 DRM 的 EPUB"}</span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".epub,application/epub+zip"
        aria-label="选择 EPUB 文件"
        hidden
        onChange={(e) => choose(e.target.files?.[0])}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="primary-button" disabled={!file || busy} onClick={submit}>
        {busy ? "上传中…" : "上传"}
      </button>
    </section>
  );
}
