// Helpers that keep several agents from registering the same project or task twice.
import { resolve } from "node:path";

/** "git@github.com:Me/App.git", "https://github.com/me/app/" → "github.com/me/app" */
export function normalizeRepoUrl(url: string | null | undefined): string {
  if (!url) return "";
  return url
    .trim()
    .toLowerCase()
    .replace(/^git\+/, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^ssh:\/\/(git@)?/, "")
    .replace(/^https?:\/\/([^@/]+@)?/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

export function normalizePath(path: string | null | undefined): string {
  if (!path) return "";
  return resolve(path.trim()).replace(/\/+$/, "").toLowerCase();
}

/** "Cohen-PM", "cohen pm", "Cohen_Pm" → "cohenpm" */
export function normalizeName(name: string): string {
  return name.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
}

const STOP = new Set([
  "a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "with", "is", "be", "it", "this", "that", "add", "make", "do",
  "my", "our", "your", "we", "i", "me", "us", "new", "all",
  "של", "את", "על", "עם", "או", "גם", "זה", "זו", "כל", "לא", "יש",
]);
const HEBREW_PREFIX = /^[והבלמשכ](?=[א-ת]{3,})/;

export function titleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const raw of title.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOP.has(raw)) continue;
    // Light stemming: Hebrew one-letter prefixes and English plural/verb endings.
    let w = raw.replace(HEBREW_PREFIX, "");
    if (/^[a-z]{5,}$/.test(w)) w = w.replace(/(ing|ed|es|s)$/, "");
    if (w.length > 1 || /\d/.test(w)) out.add(w);
  }
  return out;
}

/** 0..1 — blend of Jaccard and overlap, so "Fix login bug" ≈ "Login bug on Safari". */
export function titleSimilarity(a: string, b: string): number {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  if (common === 0) return 0;
  // A single shared word is not enough evidence unless one title is that word.
  if (common === 1 && Math.min(A.size, B.size) > 1) return 0;
  const jaccard = common / (A.size + B.size - common);
  const overlap = common / Math.min(A.size, B.size);
  return Math.round((0.5 * jaccard + 0.5 * overlap) * 100) / 100;
}
