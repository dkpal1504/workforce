import { createHash } from "node:crypto";
import { prisma } from "../db";
import { writeAudit } from "../audit";
import { loadReviewDashboard, type ReviewActor, type ReviewPeriodRequest } from "./reviewData";
import type { ReviewPayload } from "./reviewPayload";

/**
 * FROZEN MEANS FROZEN.
 *
 * A snapshot is the review payload serialised once, hashed, and never recomputed. The pack, the "what did we
 * know on <date>" screen and the trend all read this row; nothing in this module ever touches live tables on
 * the READ path, so a Job Order deleted in November cannot change what October's pack says.
 *
 * Three decisions worth stating, because each one is a trap:
 *
 *   1. The payload is stored with `snapshot: null`. The row's own id, revision and capturedAt ARE the
 *      provenance, and the pack reads them from the row. Embedding the id inside the hashed payload would
 *      make the hash depend on the insert order — the hash would then prove nothing.
 *
 *   2. The hash is over CANONICAL JSON (keys sorted, recursively). `JSON.stringify` preserves insertion
 *      order, so two identical payloads built by different code paths would hash differently and a false
 *      "corrupt" alarm would be the result.
 *
 *   3. Re-capturing a period appends a REVISION; it never edits the previous one. Two packs from different
 *      months can therefore be compared, which is the entire reason the feature exists. Capturing the same
 *      period twice with nothing changed returns the existing revision instead of inventing a second.
 */

export type CaptureTrigger = "SCHEDULED" | "ON_DEMAND" | "REVIEW_CLOSE" | "BACKFILL";

export type CaptureResult = {
  snapshot: {
    id: number;
    projectId: number;
    kind: string;
    periodFrom: string;
    periodTo: string;
    revision: number;
    provisional: boolean;
    captureTrigger: string;
    capturedAt: string;
    contentHash: string;
    payloadBytes: number;
  };
  /** True when this call wrote a new row; false when it returned the existing revision untouched. */
  created: boolean;
};

/** Deterministic JSON: object keys sorted at every level, arrays in order. */
export function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    // A Date must serialise the way it does in the stored JSON (an ISO string), or the write-time hash and
    // the read-time hash disagree — Dates have no own keys, so treating one as a plain object produced `{}`.
    if (input instanceof Date) return input.toISOString();
    // A float does not survive jsonb unchanged: Postgres stores JSON numbers as `numeric`, which keeps about
    // fifteen significant digits, so 3.1857142857142855 comes back as 3.185714285714285 and the read-time hash
    // would never match the write-time one. Twelve significant digits is far more precision than any review
    // prints and far less than the round-trip noise.
    if (typeof input === "number" && !Number.isInteger(input)) return Number(input.toPrecision(12));
    if (input && typeof input === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        sorted[key] = walk((input as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/**
 * "Have the NUMBERS changed?", as opposed to "has the payload changed?".
 *
 * `generatedAt` moves on every build, so hashing the payload whole would make every capture look different
 * from the last and a re-capture would append a revision nobody can distinguish. The fingerprint ignores the
 * volatile metadata — the build timestamp and the snapshot back-reference — and covers everything else.
 */
export function dataFingerprint(payload: ReviewPayload): string {
  // `frozen` and the snapshot back-reference describe how the payload is BEING STORED, not what it says, so
  // they are neutralised along with the build timestamp. Without this, a fresh build could never match a
  // stored one and every capture would append a revision.
  return payloadHash({ ...payload, generatedAt: "FIXED", snapshot: null, frozen: false });
}

/** The summary columns, so a trend query never parses a payload. */
export function summaryColumns(payload: ReviewPayload): {
  jobOrders: number;
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  scheduledCount: number;
  delayedCount: number;
  openEscalations: number;
  escalationsOver30: number;
  actionsOpen: number;
  actionsOverdue: number;
  headcountPeak: number;
} {
  return {
    jobOrders: payload.pulse.jobOrders,
    budgetHours: payload.pulse.budgetHours,
    actualHours: payload.pulse.actualHours,
    burnPct: payload.pulse.burnPct,
    scheduledCount: payload.jobOrderIndex.filter((row) => row.scheduled).length,
    delayedCount: payload.pulse.delayed,
    openEscalations: payload.pulse.openEscalations,
    escalationsOver30: payload.pulse.escalationsOver30,
    actionsOpen: payload.pulse.actionsOpen,
    actionsOverdue: payload.pulse.actionsOverdue,
    headcountPeak: payload.pulse.headcountPeak,
  };
}

export async function captureReviewSnapshot(input: {
  projectId: number;
  actor: ReviewActor;
  period: ReviewPeriodRequest;
  trigger?: CaptureTrigger;
  /** Write a new revision even when the payload is byte-identical. */
  force?: boolean;
  now?: Date;
}): Promise<CaptureResult> {
  const now = input.now ?? new Date();
  const dashboard = await loadReviewDashboard({
    projectId: input.projectId,
    actor: input.actor,
    period: input.period,
    now,
  });
  const payload = dashboard.payload;
  const periodFrom = new Date(`${payload.period.start}T00:00:00.000Z`);
  const periodTo = new Date(`${payload.period.end}T23:59:59.999Z`);

  const frozen: ReviewPayload = { ...payload, frozen: true, snapshot: null };
  const json = canonicalJson(frozen);
  const hash = payloadHash(frozen);

  const previous = await prisma.reportSnapshot.findFirst({
    where: { projectId: input.projectId, kind: payload.period.kind, periodFrom, periodTo },
    orderBy: { revision: "desc" },
    select: {
      id: true,
      revision: true,
      contentHash: true,
      provisional: true,
      captureTrigger: true,
      frozenAt: true,
      payloadBytes: true,
      payload: true,
    },
  });
  const fingerprint = dataFingerprint(frozen);
  const previousFingerprint = previous ? dataFingerprint(previous.payload as unknown as ReviewPayload) : null;

  if (previous && !input.force) {
    // Same numbers, same revision: capturing again would create a revision nobody can tell apart from the
    // first, and a history of indistinguishable revisions is worse than a short history.
    if (previousFingerprint === fingerprint) {
      return {
        created: false,
        snapshot: {
          id: previous.id,
          projectId: input.projectId,
          kind: payload.period.kind,
          periodFrom: payload.period.start,
          periodTo: payload.period.end,
          revision: previous.revision,
          provisional: previous.provisional,
          captureTrigger: previous.captureTrigger,
          capturedAt: previous.frozenAt.toISOString(),
          contentHash: previous.contentHash,
          payloadBytes: previous.payloadBytes,
        },
      };
    }
    // The period is still running and this is a re-capture of a provisional snapshot: replace it rather
    // than stacking revisions on every click, because a provisional number is not history yet.
    if (previous.provisional) {
      const summary = summaryColumns(frozen);
      const updated = await prisma.reportSnapshot.update({
        where: { id: previous.id },
        data: {
          payload: frozen as unknown as object,
          contentHash: hash,
          payloadBytes: Buffer.byteLength(json, "utf8"),
          provisional: frozen.period.provisional,
          captureTrigger: input.trigger ?? "ON_DEMAND",
          frozenAt: now,
          frozenById: input.actor.id || null,
          ...summary,
        },
        select: { id: true, revision: true, frozenAt: true },
      });
      await audit(input.actor.id, updated.id, frozen, "REVIEW_SNAPSHOT_REVISED");
      return {
        created: true,
        snapshot: {
          id: updated.id,
          projectId: input.projectId,
          kind: frozen.period.kind,
          periodFrom: frozen.period.start,
          periodTo: frozen.period.end,
          revision: updated.revision,
          provisional: frozen.period.provisional,
          captureTrigger: input.trigger ?? "ON_DEMAND",
          capturedAt: updated.frozenAt.toISOString(),
          contentHash: hash,
          payloadBytes: Buffer.byteLength(json, "utf8"),
        },
      };
    }
  }

  const revision = (previous?.revision ?? 0) + 1;
  const summary = summaryColumns(frozen);
  const created = await prisma.reportSnapshot.create({
    data: {
      projectId: input.projectId,
      kind: frozen.period.kind,
      periodFrom,
      periodTo,
      revision,
      captureTrigger: input.trigger ?? "ON_DEMAND",
      provisional: frozen.period.provisional,
      payload: frozen as unknown as object,
      contentHash: hash,
      payloadBytes: Buffer.byteLength(json, "utf8"),
      schemaVersion: frozen.schemaVersion,
      frozenById: input.actor.id || null,
      ...summary,
    },
    select: { id: true, revision: true, frozenAt: true },
  });

  await audit(input.actor.id, created.id, frozen, "REVIEW_SNAPSHOT_CAPTURED");
  return {
    created: true,
    snapshot: {
      id: created.id,
      projectId: input.projectId,
      kind: frozen.period.kind,
      periodFrom: frozen.period.start,
      periodTo: frozen.period.end,
      revision: created.revision,
      provisional: frozen.period.provisional,
      captureTrigger: input.trigger ?? "ON_DEMAND",
      capturedAt: created.frozenAt.toISOString(),
      contentHash: hash,
      payloadBytes: Buffer.byteLength(json, "utf8"),
    },
  };
}

export class SnapshotCorrupt extends Error {
  constructor() {
    super("SNAPSHOT_CORRUPT");
    this.name = "SnapshotCorrupt";
  }
}

/**
 * Read a frozen payload. The hash is re-computed from the stored bytes: if it does not match, the row was
 * edited outside this module and the numbers nobody can vouch for are refused rather than rendered.
 */
export async function loadSnapshot(snapshotId: number, db: typeof prisma = prisma): Promise<{
  snapshot: {
    id: number;
    projectId: number | null;
    kind: string;
    periodFrom: string;
    periodTo: string;
    revision: number;
    provisional: boolean;
    captureTrigger: string;
    capturedAt: string;
    contentHash: string;
    payloadBytes: number;
  };
  payload: ReviewPayload;
}> {
  // `db` exists so a test can pass a counting client and PROVE this path makes one call, on this table only.
  const row = await db.reportSnapshot.findUnique({
    where: { id: snapshotId },
    select: {
      id: true,
      projectId: true,
      kind: true,
      periodFrom: true,
      periodTo: true,
      revision: true,
      provisional: true,
      captureTrigger: true,
      frozenAt: true,
      payload: true,
      contentHash: true,
      payloadBytes: true,
    },
  });
  if (!row) throw new SnapshotMissing();
  const payload = row.payload as unknown as ReviewPayload;
  if (payloadHash(payload) !== row.contentHash) throw new SnapshotCorrupt();
  return {
    snapshot: {
      id: row.id,
      projectId: row.projectId,
      kind: row.kind,
      periodFrom: row.periodFrom.toISOString().slice(0, 10),
      periodTo: row.periodTo.toISOString().slice(0, 10),
      revision: row.revision,
      provisional: row.provisional,
      captureTrigger: row.captureTrigger,
      capturedAt: row.frozenAt.toISOString(),
      contentHash: row.contentHash,
      payloadBytes: row.payloadBytes,
    },
    payload,
  };
}

export class SnapshotMissing extends Error {
  constructor() {
    super("SNAPSHOT_NOT_FOUND");
    this.name = "SnapshotMissing";
  }
}

async function audit(actorId: number | null, snapshotId: number, payload: ReviewPayload, action: string): Promise<void> {
  await writeAudit(actorId && actorId > 0 ? actorId : null, action, "ReportSnapshot", snapshotId, {
    projectId: payload.project.id,
    projectCode: payload.project.code,
    periodKind: payload.period.kind,
    periodStart: payload.period.start,
    periodEnd: payload.period.end,
    snapshotId,
    frozen: true,
  });
}

/**
 * The scheduler's unit of work: freeze every project the organisation can see, one at a time, isolating
 * failures. One broken project must not cost the other fourteen their week.
 */
export async function captureAllReviewSnapshots(input: {
  period: ReviewPeriodRequest;
  trigger?: CaptureTrigger;
  now?: Date;
}): Promise<{ captured: number; skipped: number; failed: number; failures: Array<{ projectId: number; error: string }> }> {
  const systemActor: ReviewActor = { id: 0, name: "scheduler", role: "ADMIN", departmentId: null };
  const projects = await prisma.project.findMany({
    where: { active: true, isNonProject: false },
    select: { id: true, code: true, _count: { select: { jobOrders: true } } },
    orderBy: { code: "asc" },
  });

  let captured = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ projectId: number; error: string }> = [];

  for (const project of projects) {
    // A project with no Job Orders freezes an empty payload, which is noise in every trend and every pack.
    if (project._count.jobOrders === 0) {
      skipped += 1;
      continue;
    }
    try {
      const result = await captureReviewSnapshot({
        projectId: project.id,
        actor: systemActor,
        period: input.period,
        trigger: input.trigger ?? "SCHEDULED",
        now: input.now,
      });
      if (result.created) captured += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      failures.push({ projectId: project.id, error: error instanceof Error ? error.message : String(error) });
      console.error(`[reviewSnapshot] ${project.code} failed:`, error);
    }
  }

  return { captured, skipped, failed, failures };
}
