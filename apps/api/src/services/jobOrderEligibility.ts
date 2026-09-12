import { prisma } from "../db";

export async function assignableJobOrders(ids: number[]) {
  const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  const rows = uniqueIds.length ? await prisma.jobOrder.findMany({
    where: { id: { in: uniqueIds }, status: "active" },
    include: { project: true, department: true },
  }) : [];
  return new Map(rows.filter((row) => row.project.active && row.department?.active && row.department.name.includes(" - ")).map((row) => [row.id, row]));
}

export function invalidJobOrderPayload() {
  return { error: "Work Order is inactive or has not been remapped to a combined Department.", code: "JOB_ORDER_NOT_ASSIGNABLE" };
}
