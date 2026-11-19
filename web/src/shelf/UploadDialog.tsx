import { useEffect, useRef, useState, type DragEvent } from "react";
import { getUploadPolicy, uploadBook, type Book, type UploadPolicy, type Voice } from "../api";
import { UploadIcon, XIcon } from "../icons";
import { DEFAULT_VOICE } from "../voices";
import { maxFileMb, uploadRefusal } from "./uploadCheck";
import { VoicePicker } from "./VoicePicker";

interface Props {
  onClose(): void;
  onUploaded(book: Book): void;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * 上传书籍 (F4, design 04-1): pick or drop an EPUB, choose its Voice (美音女声 unless the user picks another, each
 * with a 5-second preview, PRD 4.2.4), confirm the upload rights declaration when the user has not confirmed this
 * version yet (PRD 4.1.2), and upload it with a progress bar that can be cancelled. A file the API would refuse
 * (format, size, quota: AC-UP-01 to AC-UP-03) is refused here as soon as it is chosen, and every refusal is shown
 * in the dialog, which stays open.
 */
export function UploadDialog({ onClose, onUploaded }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [policy, setPolicy] = useState<UploadPolicy | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [voice, setVoice] = useState<Voice>(DEFAULT_VOICE);
  const [declared, setDeclared] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Share sent while uploading, null otherwise. */
  const [progress, setProgress] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const upload = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    getUploadPolicy().then(
      (p) => active && setPolicy(p),
      (err: unknown) => active && setFailure(err instanceof Error ? err.message : "加载失败"),
    );
    return () => {
      active = false;
      // Closing the dialog cancels an upload under way.
      upload.current?.abort();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const needsDeclaration = policy !== null && !policy.declaration.accepted;
  const refusal = file && policy ? uploadRefusal(file, policy) : null;
  const uploading = progress !== null;
  const canUpload = file !== null && policy !== null && !refusal && (!needsDeclaration || declared) && !uploading;

  function choose(next: File | undefined) {
    if (uploading) return;
    setFile(next ?? null);
    setFailure(null);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer.files[0]);
  }

  async function submit() {
    if (!canUpload || !file || !policy) return;
    const controller = new AbortController();
    upload.current = controller;
    setFailure(null);
    setProgress(0);
    try {
      const book = await uploadBook(file, {
        voice,
        declarationVersion: needsDeclaration ? policy.declaration.version : undefined,
        onProgress: setProgress,
        signal: controller.signal,
      });
      upload.current = null;
      onUploaded(book);
    } catch (err) {
      upload.current = null;
      setProgress(null);
      // Cancelled by the user: back to the chosen file, nothing to report.
      if (!isAbort(err)) setFailure(err instanceof Error ? err.message : "上传失败，请稍后再试");
    }
  }

  const message = refusal ?? failure;
  const pct = Math.round((progress ?? 0) * 100);

  return (
    <div
      className="dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="upload-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-title">
        <div className="upload-dialog-head">
          <h2 id="upload-title" className="upload-title">
            上传书籍
          </h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <button
          type="button"
          className={`dropzone${dragging ? " is-dragging" : ""}`}
          disabled={uploading}
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
          <span className="dropzone-hint">{file ? "点击可重新选择" : policy ? `最大 ${maxFileMb(policy)}MB` : "支持无 DRM 的 EPUB"}</span>
        </button>
        <input
          ref={input}
          type="file"
          accept=".epub,application/epub+zip"
          aria-label="选择 EPUB 文件"
          hidden
          onChange={(e) => {
            choose(e.target.files?.[0]);
            // Choosing the same file again after a refusal still fires a change.
            e.target.value = "";
          }}
        />
        <VoicePicker value={voice} disabled={uploading} onChange={setVoice} />
        {needsDeclaration && (
          <label className="declaration">
            <input
              type="checkbox"
              checked={declared}
              disabled={uploading}
              onChange={(e) => setDeclared(e.target.checked)}
            />
            <span>{policy.declaration.text}</span>
          </label>
        )}
        {message && (
          <p className="form-error" role="alert">
            {message}
          </p>
        )}
        {uploading ? (
          <div className="upload-progress">
            <div className="upload-progress-row">
              <span>上传中 {pct}%</span>
              <button type="button" className="text-button" onClick={() => upload.current?.abort()}>
                取消上传
              </button>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-label="上传进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : (
          <button type="button" className="primary-button" disabled={!canUpload} onClick={submit}>
            上传
          </button>
        )}
      </section>
    </div>
  );
}
