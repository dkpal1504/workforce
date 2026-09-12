import { prisma } from "../db";

export function canonicalEcNo(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function canonicalEcNoKey(value: unknown): string {
  return canonicalEcNo(value).toLocaleUpperCase("en-US");
}

export async function findEmployeeByCanonicalEcNo(value: unknown) {
  const key = canonicalEcNoKey(value);
  if (!key) return null;
  const employees = await prisma.employee.findMany();
  return employees.find((employee) => canonicalEcNoKey(employee.ecNo) === key) ?? null;
}
