import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, RotateCwIcon, SparklesIcon } from "../icons";
import { usePresence } from "../motion";
import { AI_QUOTA_MESSAGE, useSentenceChat, type SentenceChat as Chat } from "./chatStore";

/** The user message 【AI 解析】 sends (PRD 4.5.1 #2). */
const EXPLAIN_MESSAGE = "解析这句话";
/** Closer than this to the bottom, the chat follows new text. */
const BOTTOM_SLACK_PX = 24;

function Bubble({ children }: { children: ReactNode }) {
  return (
    <div className="chat-user">
      <p className="chat-bubble">{children}</p>
    </div>
  );
}

function Replying() {
  return (
    <p className="chat-replying">
      <span className="chat-replying-dot" aria-hidden="true" />
      AI 正在回复
    </p>
  );
}

/** A line's text with **bold** shown bold and `code` marks dropped. */
function Inline({ text }: { text: string }) {
  const parts = text.replace(/`([^`]*)`/g, "$1").split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))}</>;
}

/**
 * The small Markdown the AI writes, as the panel shows it: `## ` headings become section labels (句意, 结构,
 * 短语与习语, 背景), `- ` lines list items, other lines paragraphs. Works on a partial text while it streams.
 */
function MarkdownText({ text }: { text: string }) {
  const blocks: { label: string | null; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) blocks.push({ label: heading[1]!, lines: [] });
    else if (line.trim()) {
      if (blocks.length === 0) blocks.push({ label: null, lines: [] });
      blocks.at(-1)!.lines.push(line);
    }
  }
  return (
    <>
      {blocks.map((b, i) => (
        <section key={i} className="md-section">
          {b.label && <h4>{b.label}</h4>}
          {b.lines.map((line, j) => {
            const item = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
            return (
              <p key={j} className={item ? "md-item" : undefined}>
                <Inline text={item ? item[1]! : line} />
              </p>
            );
          })}
        </section>
      ))}
    </>
  );
}

/** The Explanation with its 解析 heading; `onRegenerate` only once it is saved and nothing is generating. */
function ExplanationBlock({ text, replying, onRegenerate }: { text: string; replying: boolean; onRegenerate?: () => void }) {
  return (
    <>
      <Bubble>{EXPLAIN_MESSAGE}</Bubble>
      <article className="explanation" aria-label="解析">
        <header className="explanation-header">
          <span>
            <SparklesIcon />
            解析
          </span>
          {onRegenerate && (
            <button type="button" className="explanation-regenerate" aria-label="重新生成解析" title="重新生成" onClick={onRegenerate}>
              <RotateCwIcon size={15} />
            </button>
          )}
        </header>
        {replying && <Replying />}
        <MarkdownText text={text} />
      </article>
    </>
  );
}

/** Everything said about the Sentence, in order; changes whenever a reply grows. */
function ChatLog({ chat, canRegenerate, onRegenerate }: { chat: Chat; canRegenerate: boolean; onRegenerate(): void }) {
  const { pending } = chat;
  const explaining = pending?.kind === "explain";
  // A stopped (re)generation is the latest thing said, so it shows over the saved Explanation until reloaded.
  const explanation = explaining ? pending.text : (chat.stoppedExplanation ?? chat.content);
  return (
    <>
      {explanation !== null && (
        <ExplanationBlock
          text={explanation}
          replying={explaining}
          onRegenerate={chat.content !== null && canRegenerate ? onRegenerate : undefined}
        />
      )}
      {/* The question being answered and its reply come last, in the places they keep once saved, so they stay
          the same elements and do not fade in again. */}
      {[
        ...chat.messages.map((m) => ({ ...m, replying: false })),
        ...(pending?.kind === "ask"
          ? [
              { role: "user" as const, content: pending.question, replying: false },
              { role: "assistant" as const, content: pending.text, replying: true },
            ]
          : []),
      ].map((m, i) =>
        m.role === "user" ? (
          <Bubble key={i}>{m.content}</Bubble>
        ) : (
          <div key={i} className="chat-answer-block">
            {m.replying && <Replying />}
            <div className="chat-answer">
              <MarkdownText text={m.content} />
            </div>
          </div>
        ),
      )}
      {chat.error && (
        <p className="chat-error" role="alert">
          {chat.error}
        </p>
      )}
    </>
  );
}

/**
 * Keeps the chat at its bottom while the user is there, so a reply is followed; once they scroll up to read,
 * it stays put and offers 【新回复】 instead (AC-PANEL-10).
 */
function useFollowBottom(changed: string) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [newReply, setNewReply] = useState(false);
  const toBottom = () => {
    const el = scroller.current!;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setNewReply(false);
  };
  useLayoutEffect(() => {
    if (atBottom.current) toBottom();
    else setNewReply(true);
  }, [changed]);
  const onScroll = () => {
    const el = scroller.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
    if (atBottom.current) setNewReply(false);
  };
  return { scroller, onScroll, newReply, toBottom };
}

function placeholder(sentenceId: string | null, chat: Chat): string {
  if (chat.pending?.kind === "explain") return "正在解析…";
  if (chat.pending) return "正在回复…";
  return sentenceId && chat.content !== null ? "追问这一句" : "问问这一句";
}

/**
 * 句子精读's chat (F11): the Explanation and follow-up questions in their own scrolling area, the 【AI 解析】
 * quick action with today's calls left, and the floating ask bar whose send button turns into stop while a reply
 * is generated. Without a Sentence everything is disabled and the chat area shows `children` (the empty state).
 */
export function SentenceChat({ sentenceId, children }: { sentenceId: string | null; children?: ReactNode }) {
  const { chat, remaining, explain, ask, stop } = useSentenceChat(sentenceId);
  const [draft, setDraft] = useState("");
  const busy = chat.pending !== null;
  const exhausted = remaining === 0;
  // What a reply adds; other changes (loading, an error) are no 新回复.
  const said = `${chat.content?.length}|${chat.stoppedExplanation?.length}|${chat.messages.length}|${chat.pending?.text.length}`;
  const { scroller, onScroll, newReply, toBottom } = useFollowBottom(said);

  const explained = chat.content !== null || chat.pending?.kind === "explain";
  const quickAction = sentenceId !== null && chat.loaded && !explained;
  // The 【新回复】 chip and the quick row fade away when they are done, showing what they last showed.
  const newReplyChip = usePresence(newReply);
  const quick = usePresence(
    (quickAction || (sentenceId !== null && exhausted)) && { quickAction, exhausted, remaining, busy },
  );
  const question = draft.trim();
  const canSend = sentenceId !== null && !busy && !exhausted && question !== "";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    ask(question);
    setDraft("");
  };

  return (
    <div className="sentence-chat">
      <div ref={scroller} className="chat-scroll" onScroll={onScroll} role="log" aria-label="聊天记录">
        {children}
        <ChatLog chat={chat} canRegenerate={!busy && !exhausted} onRegenerate={explain} />
      </div>
      <div className="chat-dock">
        {newReplyChip.value && (
          <button
            type="button"
            className={newReplyChip.exiting ? "chat-chip chat-new-reply is-exiting" : "chat-chip chat-new-reply"}
            onClick={toBottom}
          >
            <ArrowDownIcon />
            新回复
          </button>
        )}
        {quick.value && (
          <div className={quick.exiting ? "chat-quick is-exiting" : "chat-quick"}>
            {quick.value.quickAction && (
              <button
                type="button"
                className="chat-chip"
                disabled={quick.value.busy || quick.value.exhausted}
                onClick={explain}
              >
                <SparklesIcon />
                AI 解析
              </button>
            )}
            {quick.value.exhausted ? (
              <span className="chat-quota is-out">{AI_QUOTA_MESSAGE}</span>
            ) : (
              quick.value.remaining !== null && <span className="chat-quota">今日剩余 {quick.value.remaining}</span>
            )}
          </div>
        )}
        <form className="ask-bar" onSubmit={onSubmit}>
          <input
            type="text"
            aria-label="提问"
            value={draft}
            placeholder={placeholder(sentenceId, chat)}
            disabled={sentenceId === null || busy}
            onChange={(e) => setDraft(e.target.value)}
          />
          {busy ? (
            <button type="button" className="ask-send is-stop" aria-label="停止" title="停止" onClick={stop}>
              <span className="ask-stop-square icon-swap" />
            </button>
          ) : (
            <button type="submit" className="ask-send" aria-label="发送" title="发送" disabled={!canSend}>
              <span className="icon-swap">
                <ArrowUpIcon />
              </span>
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
