import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db";

export type AuthUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  departmentId: number | null;
  sectionId: number | null;
  employeeId: number | null;
  mustChangePassword: boolean;
  tokenVersion: number;
};

type TokenClaims = {
  id: number;
  tokenVersion: number;
  iat?: number;
  exp?: number;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "workforce-dev-secret";
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required in production.");
}

export function signToken(user: Pick<AuthUser, "id" | "tokenVersion">): string {
  return jwt.sign({ id: user.id, tokenVersion: user.tokenVersion }, JWT_SECRET, { expiresIn: "12h" });
}

function lifecycleError(res: Response, code: string, error: string) {
  return res.status(401).json({ error, code });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return lifecycleError(res, "UNAUTHORIZED", "Unauthorized");
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as TokenClaims;
    if (!Number.isInteger(payload.id) || !Number.isInteger(payload.tokenVersion)) {
      return lifecycleError(res, "INVALID_TOKEN", "Invalid token");
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        departmentId: true,
        sectionId: true,
        employeeId: true,
        active: true,
        mustChangePassword: true,
        tokenVersion: true,
        passwordExpiresAt: true,
        employee: { select: { active: true } },
      },
    });
    if (!user) {
      return lifecycleError(res, "SESSION_REVOKED", "Session expired or account no longer exists. Please log in again.");
    }
    if (!user.active || (user.employeeId != null && !user.employee?.active)) {
      return lifecycleError(res, "ACCOUNT_INACTIVE", "This account is inactive. Contact support.");
    }
    if (payload.tokenVersion !== user.tokenVersion) {
      return lifecycleError(res, "SESSION_REVOKED", "Your session has been revoked. Please log in again.");
    }
    if (user.passwordExpiresAt && user.passwordExpiresAt.getTime() <= Date.now()) {
      return lifecycleError(res, "CREDENTIAL_EXPIRED", "Your temporary credential has expired. Contact support.");
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      departmentId: user.departmentId,
      sectionId: user.sectionId,
      employeeId: user.employeeId,
      mustChangePassword: user.mustChangePassword,
      tokenVersion: user.tokenVersion,
    };

    // A first-login credential grants access only to the lifecycle endpoints. This is
    // hard in EVERY environment: an account provisioned with the shared
    // BOOTSTRAP_PASSWORD (contract workers and supervisors have no e-mail address)
    // or with an e-mailed one-time credential must set its own password before it
    // can reach anything else.
    const allowedWhileChanging = new Set(["/api/auth/me", "/api/auth/logout", "/api/auth/change-password"]);
    const forcePasswordChange = user.mustChangePassword;
    if (forcePasswordChange && !allowedWhileChanging.has(req.originalUrl.split("?")[0])) {
      return res.status(403).json({
        error: "You must change your temporary password before continuing.",
        code: "PASSWORD_CHANGE_REQUIRED",
      });
    }

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return lifecycleError(res, "TOKEN_EXPIRED", "Session expired. Please log in again.");
    }
    return lifecycleError(res, "INVALID_TOKEN", "Invalid token");
  }
}

export function requireRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    }
    next();
  };
}
