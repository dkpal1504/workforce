/**
 * The signed link that lets somebody answer from an e-mail without an account.
 *
 * WHAT IT IS NOT: a session. It cannot read another thread, cannot change any record, cannot approve
 * anything. It can render ONE Job Order's conversation and append a reply to it, and it expires.
 *
 * The value is 32 random bytes, base64url (43 characters). Only its SHA-256 HASH is stored, so a
 * database read cannot be replayed as a working link, and the token is bound to one address and one
 * thread at creation.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_TOKEN_DAYS = 30;

export function createReplyTokenValue(): string {
  return randomBytes(32).toString("base64url");
}

export function hashReplyToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of a presented value against a stored hash. */
export function replyTokenMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashReplyToken(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function replyTokenExpiry(now: Date, days: number = DEFAULT_TOKEN_DAYS): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

export type TokenState = "USABLE" | "EXPIRED" | "REVOKED";

export function tokenState(
  row: { expiresAt: Date; revokedAt: Date | null },
  now: Date
): TokenState {
  if (row.revokedAt) return "REVOKED";
  if (row.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "USABLE";
}

/** The path the e-mail button points at. One place, so the route and the mail cannot drift. */
export function replyLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/thread/${token}`;
}

/**
 * The public page is served from the SPA, so a crawler or a mail scanner that follows the link must
 * not consume anything: the token is read-only until a reply is POSTed. This is why the GET renders
 * and the POST acts — no single "click to confirm" action anywhere.
 */
export function publicThreadPath(token: string): string {
  return `/thread/${token}`;
}
