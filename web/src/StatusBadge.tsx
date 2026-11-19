import type { BookStatus } from "./api";
import { AudioLinesIcon, CircleAlertIcon, LoaderIcon } from "./icons";

const STATUS_LABEL: Record<BookStatus, string> = {
  parsing: "解析中",
  generating: "生成中",
  ready: "已就绪",
  parse_failed: "解析失败",
};

/** A Book's main status with its icon (PRD 4.3.3), as the Shelf and the Book detail show it. */
export function StatusBadge({ status }: { status: BookStatus }) {
  const icon =
    status === "parse_failed" ? <CircleAlertIcon /> : status === "parsing" ? <LoaderIcon /> : <AudioLinesIcon size={12} />;
  return (
    <span className={`status status-${status}`}>
      {icon}
      {STATUS_LABEL[status]}
    </span>
  );
}
