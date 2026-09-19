import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Minimal bootstrap seed: the PRODUCTION-LIKE starting point.
 *
 * It creates only the four office accounts an operator needs to sign in, and no
 * business data at all. Everything else arrives the way it will in production:
 *
 *   - Departments, Sections, Employees and Supervisor logins come from the LabourWorks
 *     sync (Admin -> Sync, or POST /api/admin/sync/badgeview). A synced Supervisor logs
 *     in with the EcNo and the shared bootstrap password while the app is pre-production.
 *   - Projects, WBS rows, UoM and Networks are created by the PM team on Project Master
 *     Data (`/master-data`).
 *   - Job Orders are uploaded from the CSV template (`/job-order-upload`).
 *
 * The full demonstration data set (projects, WBS, Job Orders, employees, bookings) lives
 * in `prisma/seed-demo.ts` and is run with `npm run db:seed:demo`. The end-to-end tests
 * need that data.
 *
 * COST RATES ARE NOT SEEDED. The Summary screens read them for the Cost view; add them
 * with POST /api/admin/cost-rates (category, ratePerHour, effectiveFrom) or the Cost view
 * will read zero.
 */
async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV=production. This seed creates accounts with a known development password.");
  }
  const devPassword = process.env.DEV_SEED_PASSWORD || "WorkforceDev@2026";
  const passwordHash = await bcrypt.hash(devPassword, 10);

  await prisma.auditLog.deleteMany();
  await prisma.employeeAllocation.deleteMany();
  await prisma.employeeAllocationApproval.deleteMany();
  await prisma.employeeAllocationDay.deleteMany();
  await prisma.timesheetEntry.deleteMany();
  await prisma.approval.deleteMany();
  await prisma.timesheetDay.deleteMany();
  await prisma.dailyTeamSelection.deleteMany();
  await prisma.conflict.deleteMany();
  await prisma.manpowerRequest.deleteMany();
  await prisma.attendanceFeed.deleteMany();
  await prisma.costRate.deleteMany();
  await prisma.credentialDelivery.deleteMany();
  await prisma.supervisorOverride.deleteMany();
  await prisma.employeeOrganisationOverride.deleteMany();
  await prisma.employeeSectionAssignment.deleteMany();
  await prisma.costCenter.deleteMany();
  await prisma.section.deleteMany();
  await prisma.syncException.deleteMany();
  await prisma.jobOrderProgressRemark.deleteMany();
  await prisma.jobOrderProgress.deleteMany();
  await prisma.jobOrderBudgetRevision.deleteMany();
  await prisma.jobOrder.deleteMany();
  await prisma.network.deleteMany();
  await prisma.project.deleteMany();
  await prisma.projectWbs.deleteMany();
  await prisma.uom.deleteMany();
  await prisma.user.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.department.deleteMany();

  const accounts = [
    { email: "admin@company.com", name: "System Admin", role: "ADMIN" },
    { email: "pm@company.com", name: "Project Head", role: "PM" },
    { email: "hr@company.com", name: "HR User", role: "HR" },
    { email: "finance@company.com", name: "Finance User", role: "FINANCE" },
  ];

  for (const account of accounts) {
    await prisma.user.create({
      data: {
        email: account.email,
        passwordHash,
        name: account.name,
        role: account.role,
        source: "MANUAL",
        // No forced password change: this is a controlled bootstrap.
        mustChangePassword: false,
      },
    });
  }

  console.log("Minimal seed complete — no business data was created.");
  console.log("");
  console.log("Sign in with:");
  for (const account of accounts) console.log(`  ${account.role.padEnd(8)} ${account.email} / ${devPassword}`);
  console.log("");
  console.log("Next steps, in this order:");
  console.log("  1. Sync from LabourWorks to create Departments, Sections and Supervisors");
  console.log("     (Admin -> Sync, or POST /api/admin/sync/badgeview).");
  console.log("  2. On Project Master Data create the Project, its WBS rows, the UoM and the Networks.");
  console.log("  3. Upload the Job Orders from the CSV template.");
  console.log("  4. Add cost rates (POST /api/admin/cost-rates) if you want the Cost view.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
