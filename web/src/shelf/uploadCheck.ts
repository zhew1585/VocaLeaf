// The checks the upload dialog runs on a chosen file before sending it (PRD 4.3.2, 4.3.5 #1 to #3), in the PRD's
// order, with the API's own messages; the API runs them again, so these only spare sending a file it would refuse.
import type { UploadPolicy } from "../api";

/** Why the file cannot be uploaded, or null when it can. */
export function uploadRefusal(file: File, policy: UploadPolicy): string | null {
  if (!/\.epub$/i.test(file.name)) return "目前只支持 EPUB 格式";
  if (file.size > policy.maxFileBytes) return `文件不能超过 ${Math.round(policy.maxFileBytes / 1024 / 1024)}MB`;
  if (policy.uploadedBooks >= policy.maxBooks) {
    return `内测期最多上传 ${policy.maxBooks} 本书，可删除不再听的书后再上传`;
  }
  return null;
}
