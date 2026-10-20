/**
 * Documents on a conversation message — drawings, site photos, delivery notes, spreadsheets.
 *
 * RULES, all enforced server-side:
 *   - several per message (up to MAX_PER_MESSAGE), 10 MB each;
 *   - an allow-list of extensions, and a block-list that wins over it (SVG and HTML are refused: they
 *     are scripts, not documents, and would render in the browser);
 *   - the bytes are written under an opaque random name and NEVER under the user's filename, so a
 *     `../../` or a `.php` in the name cannot escape the directory or execute;
 *   - every download is authorised again, against the caller's scope (or the reply token's thread);
 *   - everything is served `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`.
 *
 * NOT DONE, and stated plainly in the docs: there is no anti-virus scanner on this host. The type
 * allow-list is the mitigation, not a guarantee. If a scanner is added, it belongs in `saveUpload`
 * between the write and the row.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../db";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

const ALLOWED = new Set([
  "pdf", "png", "jpg", "jpeg", "webp",
  "xls", "xlsx", "csv",
  "doc", "docx", "ppt", "pptx", "txt",
  "zip",
]);

/** Wins over ALLOWED even if an extension is added there by mistake. */
const BLOCKED = new Set([
  "exe", "bat", "cmd", "com", "pif", "scr", "msi", "dll", "jar",
  "js", "mjs", "cjs", "vbs", "ps1", "sh", "py", "pl", "php",
  "html", "htm", "xhtml", "svg", "xml",
]);

/** The MIME used when serving a file, chosen from the ALLOW-LISTED extension — never from the upload. */
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  zip: "application/zip",
};

export function attachmentDir(): string {
  return process.env.ATTACHMENT_DIR ?? path.join(process.cwd(), "data", "attachments");
}

/** A name a person can recognise: no path, no control characters, at most 120 characters. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "document";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  const safe = cleaned || "document";
  if (safe.length <= 120) return safe;
  const dot = safe.lastIndexOf(".");
  const ext = dot > 0 ? safe.slice(dot) : "";
  return safe.slice(0, 120 - ext.length) + ext;
}

export function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename);
  return match ? match[1].toLowerCase() : "";
}

export type InspectResult =
  | { ok: true; extension: string; mimeType: string }
  | { ok: false; reason: "EMPTY" | "TOO_LARGE" | "NO_EXTENSION" | "TYPE_NOT_ALLOWED" };

/** Decide whether this upload may be stored. PURE — the route calls it before touching the disk. */
export function inspectUpload(input: { filename: string; sizeBytes: number }): InspectResult {
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) return { ok: false, reason: "EMPTY" };
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "TOO_LARGE" };
  const extension = extensionOf(input.filename);
  if (!extension) return { ok: false, reason: "NO_EXTENSION" };
  if (BLOCKED.has(extension) || !ALLOWED.has(extension)) {
    return { ok: false, reason: "TYPE_NOT_ALLOWED" };
  }
  return { ok: true, extension, mimeType: MIME[extension] ?? "application/octet-stream" };
}

/** Store one uploaded file and index it. The row is created with no `messageId`: it is "pending". */
export async function saveUpload(input: {
  threadId: number;
  uploadedById: number | null;
  filename: string;
  bytes: Buffer;
}): Promise<{ id: number; filename: string; sizeBytes: number } | { ok: false; reason: string }> {
  const filename = sanitizeFilename(input.filename);
  const verdict = inspectUpload({ filename, sizeBytes: input.bytes.length });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  const dir = attachmentDir();
  mkdirSync(dir, { recursive: true });
  const storageKey = `${randomUUID()}.${verdict.extension}`;
  const target = path.join(dir, storageKey);
  writeFileSync(target, input.bytes);

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const row = await prisma.jobOrderMessageAttachment.create({
    data: {
      threadId: input.threadId,
      messageId: null,
      filename,
      mimeType: verdict.mimeType,
      sizeBytes: input.bytes.length,
      storageKey,
      sha256,
      uploadedById: input.uploadedById,
    },
    select: { id: true, filename: true, sizeBytes: true },
  });
  return row;
}

/**
 * Attach pending uploads to the message that was just created.
 *
 * Only the uploader's own pending rows in THIS thread are accepted, and at most the cap — so a
 * crafted id list cannot borrow somebody else's file, or another Job Order's.
 */
export async function attachToMessage(input: {
  attachmentIds: number[];
  threadId: number;
  messageId: number;
  uploadedById: number | null;
}): Promise<number> {
  const ids = [...new Set(input.attachmentIds)].slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  if (!ids.length) return 0;
  const updated = await prisma.jobOrderMessageAttachment.updateMany({
    where: {
      id: { in: ids },
      threadId: input.threadId,
      messageId: null,
      ...(input.uploadedById == null ? {} : { uploadedById: input.uploadedById }),
    },
    data: { messageId: input.messageId },
  });
  return updated.count;
}

export type DownloadTicket = { absolutePath: string; filename: string; mimeType: string; sizeBytes: number };

/** Resolve a row to a file on disk. Authorisation is the CALLER's job; this only refuses missing bytes. */
export async function downloadTicket(attachmentId: number): Promise<DownloadTicket | null> {
  const row = await prisma.jobOrderMessageAttachment.findUnique({
    where: { id: attachmentId },
    select: { filename: true, mimeType: true, sizeBytes: true, storageKey: true },
  });
  if (!row) return null;
  const absolutePath = path.join(attachmentDir(), row.storageKey);
  if (!existsSync(absolutePath)) return null;
  if (statSync(absolutePath).size !== row.sizeBytes) return null;
  return { absolutePath, filename: row.filename, mimeType: row.mimeType, sizeBytes: row.sizeBytes };
}

export function sendDownload(res: import("express").Response, ticket: DownloadTicket): void {
  res.setHeader("Content-Type", ticket.mimeType);
  res.setHeader("Content-Length", String(ticket.sizeBytes));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${ticket.filename.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(ticket.filename)}`
  );
  createReadStream(ticket.absolutePath).pipe(res);
}

/**
 * Uploads that were never sent (the composer was abandoned). Swept by the conversation scheduler:
 * a row with no message after 24 hours is deleted with its bytes, because it belongs to nothing.
 */
export async function sweepOrphanUploads(olderThan: Date): Promise<number> {
  const orphans = await prisma.jobOrderMessageAttachment.findMany({
    where: { messageId: null, createdAt: { lt: olderThan } },
    select: { id: true, storageKey: true },
  });
  for (const orphan of orphans) {
    try {
      unlinkSync(path.join(attachmentDir(), orphan.storageKey));
    } catch {
      /* the bytes are already gone; the row still has to go */
    }
    await prisma.jobOrderMessageAttachment.delete({ where: { id: orphan.id } }).catch(() => undefined);
  }
  return orphans.length;
}
