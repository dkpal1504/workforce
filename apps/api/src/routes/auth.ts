import { Router } from "express";
import bcrypt from "bcryptjs";
import { loginSchema } from "@workforce/shared";
import { prisma } from "../db";
import { requireAuth, signToken } from "../middleware/auth";
import { writeAudit } from "../audit";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const authUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    departmentId: user.departmentId,
  };
  const token = signToken(authUser);
  await writeAudit(user.id, "LOGIN", "user", user.id);
  res.json({ token, user: authUser });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  await writeAudit(req.user!.id, "LOGOUT", "user", req.user!.id);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      departmentId: true,
      department: { select: { id: true, name: true, code: true } },
    },
  });
  res.json({ user });
});
