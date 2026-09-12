import { PrismaClient } from "@prisma/client";
import { hashDefaultWorkforcePassword } from "../src/services/defaultLoginCredentials";

const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.user.findMany({
    where: {
      employeeId: { not: null },
      role: { in: ["EMPLOYEE", "SUPERVISOR"] },
    },
    select: { id: true },
  });
  if (accounts.length === 0) {
    console.log("No linked Employee/Supervisor accounts required an update.");
    return;
  }

  const passwordHash = await hashDefaultWorkforcePassword();
  const updated = await prisma.user.updateMany({
    where: { id: { in: accounts.map((account) => account.id) } },
    data: {
      passwordHash,
      mustChangePassword: false,
      passwordExpiresAt: null,
      tokenVersion: { increment: 1 },
    },
  });
  console.log(`Updated ${updated.count} linked Employee/Supervisor accounts for ecNo login.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
