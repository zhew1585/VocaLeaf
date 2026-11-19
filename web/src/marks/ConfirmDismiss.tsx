import { ConfirmDialog } from "../ConfirmDialog";
import { dismissFromGleanings } from "./marks";

interface Props {
  sentenceId: string;
  onCancel(): void;
  /** Called once the Mark is Dismissed. */
  onDismissed(): void;
  /** On its way out (usePresence). */
  exiting?: boolean;
}

/**
 * The second confirmation of Dismiss (F10, PRD V1.4): 取消 (also Escape or a click outside) keeps the item, 忽略
 * Dismisses it. Shared by × in the list and 【忽略这一句】 in 句子精读.
 */
export function ConfirmDismiss({ sentenceId, onCancel, onDismissed, exiting }: Props) {
  return (
    <ConfirmDialog
      title="忽略这一句？"
      text="不会制作卡片，句子将从拾起移除"
      confirmLabel="忽略"
      run={() => dismissFromGleanings(sentenceId)}
      failure="忽略失败，请稍后再试"
      onCancel={onCancel}
      onDone={onDismissed}
      exiting={exiting}
    />
  );
}
