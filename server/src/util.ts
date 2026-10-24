import { createHash, randomBytes } from "node:crypto";

export const now = () => new Date().toISOString();

export function newId(prefix = ""): string {
  return prefix + randomBytes(9).toString("base64url").replace(/[-_]/g, "x").slice(0, 12);
}

export function newToken(): string {
  return "tdk_" + randomBytes(24).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Derive a short project key ("Tunadesk Web" -> "TW", "payments" -> "PAY"). */
export function deriveKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "PRJ";
  if (words.length === 1) return words[0].slice(0, 4);
  return words
    .map((w) => w[0])
    .join("")
    .slice(0, 5);
}

/** Pull @mentions (actor ids) out of free text. */
export function extractMentions(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9_-]{0,39})/gi)) found.add(m[1].toLowerCase());
  return [...found];
}

/** Plain-object copy of a node:sqlite row (they come back with a null prototype). */
export function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

export function periodStart(period: "day" | "week" | "month", at = new Date()): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  if (period === "week") {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    d.setUTCDate(d.getUTCDate() - dow);
  } else if (period === "month") {
    d.setUTCDate(1);
  }
  return d;
}
