import { prisma } from "./db";

export async function writeAudit(
  userId: number | null | undefined,
  action: string,
  entityType: string,
  entityId?: string | number | null,
  metadata?: unknown
) {
  try {
    let safeUserId: number | null = userId ?? null;
    if (safeUserId != null) {
      const exists = await prisma.user.findUnique({
        where: { id: safeUserId },
        select: { id: true },
      });
      if (!exists) safeUserId = null;
    }

    await prisma.auditLog.create({
      data: {
        userId: safeUserId,
        action,
        entityType,
        entityId: entityId != null ? String(entityId) : null,
        metadata: metadata != null ? JSON.stringify(metadata) : null,
      },
    });
  } catch (err) {
    // Audit must never take down a request (e.g. stale JWT after reseed)
    console.error("writeAudit failed:", err);
  }
}
