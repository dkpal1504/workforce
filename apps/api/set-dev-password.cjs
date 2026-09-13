// Local dev helper: set a known password for a Workforce account that has no
// delivered credential yet (new HOD / Employee / Supervisor accounts get an
// unknown random password until the credential-delivery worker mails one).
//
//   node apps/api/set-dev-password.cjs EC1013
//   node apps/api/set-dev-password.cjs EC1013 MyPassword@1
//
// Refuses to run against a non-SQLite database or in production. It does not
// change any application logic — it only re-hashes the password and clears the
// "credential not delivered" flag for that one account.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
require("dotenv").config();

const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  const identifier = process.argv[2];
  const password = process.argv[3] || process.env.DEV_SYNC_PASSWORD || "password@SDHI";
  if (!identifier) {
    console.error("usage: node apps/api/set-dev-password.cjs <ecNo|email> [password]");
    process.exit(1);
  }
  if (!String(process.env.DATABASE_URL || "").startsWith("file:")) {
    console.error("Refusing to run: this helper is for the local SQLite dev database only.");
    process.exit(1);
  }
  const key = String(identifier).trim();
  const user =
    (await prisma.user.findFirst({ where: { employee: { ecNo: key } }, include: { employee: true } })) ||
    (await prisma.user.findFirst({ where: { email: key.toLowerCase() }, include: { employee: true } }));
  if (!user) {
    console.error(`No account found for "${key}".`);
    process.exit(1);
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(password, 10),
      mustChangePassword: false,
      passwordExpiresAt: null,
    },
  });
  console.log(`password set for ${user.role} ${user.name} (login ${user.employee?.ecNo || user.email}) -> ${password}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
