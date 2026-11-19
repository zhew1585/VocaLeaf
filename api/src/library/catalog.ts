// The Library's book list (PRD 4.2.2, 6.3 O1): public-domain Books from Standard Ebooks, each with its difficulty
// group and the one-line blurb the 书库 shows. scripts/library.ts ingests them; edit this list and run it again to
// add Books or change a group or blurb.
import type { Difficulty } from "../contract.js";

export interface CatalogEntry {
  /** The Book's Standard Ebooks identifier: the path after /ebooks/ in its URL, e.g. jane-austen/pride-and-prejudice. */
  key: string;
  /** Shown until the EPUB is parsed; the parse then takes the title from its metadata. */
  title: string;
  difficulty: Difficulty;
  blurb: string;
}

export const LIBRARY_CATALOG: readonly CatalogEntry[] = [
  {
    key: "lewis-carroll/alices-adventures-in-wonderland/john-tenniel",
    title: "Alice’s Adventures in Wonderland",
    difficulty: "beginner",
    blurb: "掉进兔子洞的小女孩，句子短，对话多。",
  },
  {
    key: "l-frank-baum/the-wonderful-wizard-of-oz",
    title: "The Wonderful Wizard of Oz",
    difficulty: "beginner",
    blurb: "一场龙卷风，一条黄砖路，语言平实。",
  },
  {
    key: "jane-austen/pride-and-prejudice",
    title: "Pride and Prejudice",
    difficulty: "intermediate",
    blurb: "班纳特家的婚事，英式讽刺的教科书。",
  },
  {
    key: "f-scott-fitzgerald/the-great-gatsby",
    title: "The Great Gatsby",
    difficulty: "intermediate",
    blurb: "爵士时代的幻梦，文字华丽而克制。",
  },
  {
    key: "arthur-conan-doyle/the-adventures-of-sherlock-holmes",
    title: "The Adventures of Sherlock Holmes",
    difficulty: "intermediate",
    blurb: "十二个短篇探案，一篇一个通勤。",
  },
  {
    key: "mary-shelley/frankenstein",
    title: "Frankenstein",
    difficulty: "advanced",
    blurb: "造物者与被造者，长句与书信体。",
  },
  {
    key: "henry-david-thoreau/walden",
    title: "Walden",
    difficulty: "advanced",
    blurb: "湖畔两年的独居手记，思辨密集。",
  },
];

/**
 * Where Standard Ebooks serves a Book's compatible EPUB: /ebooks/{key}/downloads/{key with / as _}.epub.
 * `source=download` skips the page that thanks the reader before the download.
 */
export function standardEbooksEpubUrl(key: string): string {
  return `https://standardebooks.org/ebooks/${key}/downloads/${key.replaceAll("/", "_")}.epub?source=download`;
}
