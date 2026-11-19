import "./shelf.css";
import { ShelfHeader } from "./ShelfPage";

/** 书库 (F6) until #12 fills it: the tab and 【从书库挑一本开始听】 lead here. */
export function LibraryPage() {
  return (
    <div className="shelf-page">
      <ShelfHeader active="library" />
      <p className="library-soon">书库正在准备中，很快就能从这里挑一本公版书开始听。</p>
    </div>
  );
}
