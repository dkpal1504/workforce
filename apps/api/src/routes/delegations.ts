import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { hodScopeFromRows, hodScopeNamedSectionIds, type HodScope } from "../services/hodScope";
import { hodScopeMatchesScope } from "../services/roleAccess";

/**
 * HOD approval-cover delegations.
 *
 * Who may create: ADMIN and PM for any Department/Section; an HOD only for its own
 * Department/Section. The delegate must already be an active HOD scoped to that same
 * Department/Section, so approval authorization itself is unchanged — this record
 * makes the cover explicit, date-bounded and auditable. The delegating HOD keeps
 * their own approval rights.
 */
export const delegationRouter = Router();

delegationRouter.use(requireAuth);

const delegationSelect = {
  id: true,
  departmentId: true,
  sectionId: true,
  fromDate: true,
  toDate: true,
  reason: true,
  revokedAt: true,
  createdAt: true,
  department: { select: { id: true, name: true } },
  section: { select: { id: true, code: true, name: true } },
  delegator: { select: { id: true, name: true, email: true, employee: { select: { ecNo: true } } } },
  delegateUser: { select: { id: true, name: true, email: true, employee: { select: { ecNo: true } } } },
} as const;

function parseDateOnly(value: unknown): Date | null {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The Departments/Sections a head's delegations may touch.
 *
 * Built from the GRANT SET, not from `sectionScope`: a Sectional Head of two plants covers the whole of
 * each, which an empty section list used to encode as "nothing" (`{ in: [-1] }`). Same fail-closed
 * shape when he holds no Department at all.
 */
function delegationScopeWhere(scope: HodScope) {
  const wholeDepartments = scope.grants.filter((grant) => grant.sectionIds.length === 0).map((grant) => grant.departmentId);
  const namedSections = hodScopeNamedSectionIds(scope);
  const branches = [
    ...(wholeDepartments.length ? [{ departmentId: { in: wholeDepartments } }] : []),
    ...(namedSections.length ? [{ sectionId: { in: namedSections } }] : []),
  ];
  if (branches.length === 0) return { id: -1 };
  return branches.length === 1 ? branches[0] : { OR: branches };
}

/**
 * Every active HOD whose SCOPE covers this Department/Section — the only people who may stand in.
 *
 * Filtered in JS over the HOD list (~40 rows) because the authority now lives in two tables plus the
 * legacy scalar; expressing that in one `where` is how the delegations screen and the approvals screen
 * would end up disagreeing about who may approve.
 */
async function hodsCovering(departmentId: number, sectionId: number, excludeUserId?: number) {
  const users = await prisma.user.findMany({
    where: { role: "HOD", active: true, ...(excludeUserId ? { id: { not: excludeUserId } } : {}) },
    select: {
      id: true, name: true, email: true, departmentId: true, sectionId: true,
      scopeSections: { select: { sectionId: true, section: { select: { departmentId: true } } } },
      scopeDepartments: { select: { departmentId: true } },
      employee: { select: { ecNo: true } },
    },
    orderBy: { name: "asc" },
  });
  return users.filter((candidate) =>
    hodScopeMatchesScope(
      hodScopeFromRows({
        departmentId: candidate.departmentId,
        legacySectionId: candidate.sectionId,
        departmentGrants: candidate.scopeDepartments.map((grant) => grant.departmentId),
        sectionRows: candidate.scopeSections.map((row) => ({ sectionId: row.sectionId, departmentId: row.section.departmentId })),
      }),
      departmentId,
      sectionId
    )
  );
}

/** Active cover = not revoked and today inside [fromDate, toDate]. */
function activeOn(date: Date) {
  return { revokedAt: null, fromDate: { lte: date }, toDate: { gte: date } };
}

/**
 * GET /api/delegations — delegations the caller may see.
 * HOD: the ones covering its own Section, plus the ones it created.
 * ADMIN/PM: all of them (optionally narrowed by department_id/section_id).
 */
delegationRouter.get("/", requireRoles("HOD", "PM", "ADMIN"), async (req, res) => {
  const role = req.user!.role;
  const departmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  const sectionId = req.query.section_id ? Number(req.query.section_id) : undefined;
  const includeRevoked = String(req.query.include_revoked || "") === "true";

  const visibility =
    role === "HOD"
      ? { OR: [{ delegatorId: req.user!.id }, { delegateUserId: req.user!.id }, delegationScopeWhere(req.user!.hodScope)] }
      : {};

  const delegations = await prisma.hodDelegation.findMany({
    where: {
      ...visibility,
      ...(departmentId ? { departmentId } : {}),
      ...(sectionId ? { sectionId } : {}),
      ...(includeRevoked ? {} : { revokedAt: null }),
    },
    select: delegationSelect,
    orderBy: [{ fromDate: "desc" }, { id: "desc" }],
    take: 300,
  });
  res.json({ delegations });
});

/**
 * GET /api/delegations/coverage — who covers the caller's Section, and who the
 * caller currently covers. Drives the "Deputy HOD" banner on Approvals.
 */
delegationRouter.get("/coverage", requireRoles("HOD", "PM", "ADMIN"), async (req, res) => {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const role = req.user!.role;
  const scope = req.user!.hodScope;

  const [coveringMe, iAmCovering] = await Promise.all([
    role === "HOD"
      ? prisma.hodDelegation.findMany({
          where: { ...activeOn(today), ...delegationScopeWhere(scope) },
          select: delegationSelect,
        })
      : Promise.resolve([]),
    prisma.hodDelegation.findMany({
      where: { ...activeOn(today), delegateUserId: req.user!.id },
      select: delegationSelect,
    }),
  ]);

  res.json({ coveringMe, iAmCovering, isDeputyToday: iAmCovering.length > 0 });
});

/**
 * POST /api/delegations — create approval cover.
 * HOD is restricted to its own Department/Section; ADMIN/PM may cover any Section.
 */
delegationRouter.post("/", requireRoles("HOD", "PM", "ADMIN"), async (req, res) => {
  const role = req.user!.role;
  const departmentId = Number(req.body?.departmentId);
  const sectionId = Number(req.body?.sectionId);
  const delegateUserId = Number(req.body?.delegateUserId);
  const fromDate = parseDateOnly(req.body?.fromDate);
  const toDate = parseDateOnly(req.body?.toDate);
  const reason = String(req.body?.reason ?? "").trim();

  if (!departmentId || !sectionId || !delegateUserId || !fromDate || !toDate) {
    return res.status(400).json({ error: "departmentId, sectionId, delegateUserId, fromDate and toDate are required." });
  }
  if (toDate < fromDate) return res.status(400).json({ error: "toDate must be on or after fromDate.", code: "INVALID_RANGE" });
  if (!reason) return res.status(400).json({ error: "A reason is required for an approval-cover delegation.", code: "REASON_REQUIRED" });

  // An HOD may only arrange cover for the Section it owns.
  if (role === "HOD" && !hodScopeMatchesScope(req.user!.hodScope, departmentId, sectionId)) {
    return res.status(403).json({
      error: "An HOD can delegate only for a Section in one of their granted Departments.",
      code: "WRONG_SCOPE",
    });
  }

  const section = await prisma.section.findFirst({
    where: { id: sectionId, departmentId, active: true, department: { active: true } },
    select: { id: true },
  });
  if (!section) return res.status(400).json({ error: "Select an active Section in the Department.", code: "INVALID_SCOPE" });

  // The delegate must already be an active HOD of that same Section (their approval
  // authorization is unchanged; this is a stand-in, e.g. leave cover).
  const delegate = (await hodsCovering(departmentId, sectionId)).find((candidate) => candidate.id === delegateUserId);
  if (!delegate) {
    return res.status(400).json({
      error: "The delegate must be an active HOD mapped to that same Department/Section.",
      code: "INVALID_DELEGATE",
    });
  }
  // HOD covering its own section for itself is meaningless.
  if (delegateUserId === req.user!.id) {
    return res.status(400).json({ error: "You cannot delegate approval cover to yourself.", code: "SELF_DELEGATION" });
  }

  // A delegated HOD must exist per Section, so the delegator is either the caller
  // (HOD) or the Section's current HOD (created on their behalf by ADMIN/PM).
  const delegatorId = role === "HOD"
    ? req.user!.id
    : (await hodsCovering(departmentId, sectionId, delegateUserId))[0]?.id ?? null;
  if (!delegatorId) {
    return res.status(400).json({
      error: "No HOD is mapped to that Section to delegate from. Map an HOD first.",
      code: "NO_DELEGATOR",
    });
  }
  if (delegatorId === delegateUserId) {
    return res.status(400).json({ error: "The delegate must be a different HOD than the one delegating.", code: "SELF_DELEGATION" });
  }

  const overlap = await prisma.hodDelegation.findFirst({
    where: { sectionId, delegateUserId, revokedAt: null, fromDate: { lte: toDate }, toDate: { gte: fromDate } },
    select: { id: true },
  });
  if (overlap) {
    return res.status(409).json({ error: "That HOD already has approval cover for this Section in the selected period.", code: "OVERLAPPING_DELEGATION" });
  }

  const created = await prisma.hodDelegation.create({
    data: { delegatorId, delegateUserId, departmentId, sectionId, fromDate, toDate, reason, createdById: req.user!.id },
    select: delegationSelect,
  });
  await writeAudit(req.user!.id, "HOD_DELEGATION_CREATE", "hod_delegation", created.id, {
    delegatorId, delegateUserId, departmentId, sectionId,
    fromDate: fromDate.toISOString().slice(0, 10), toDate: toDate.toISOString().slice(0, 10),
  });
  res.status(201).json({ delegation: created });
});

/** DELETE /api/delegations/:id — revoke cover early (delegator, ADMIN or PM). */
delegationRouter.delete("/:id", requireRoles("HOD", "PM", "ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  const role = req.user!.role;
  const delegation = await prisma.hodDelegation.findUnique({ where: { id }, select: { id: true, delegatorId: true, departmentId: true, sectionId: true, revokedAt: true } });
  if (!delegation) return res.status(404).json({ error: "Delegation not found." });
  if (delegation.revokedAt) return res.status(409).json({ error: "Delegation is already revoked.", code: "ALREADY_REVOKED" });
  if (role === "HOD" && (delegation.delegatorId !== req.user!.id || !hodScopeMatchesScope(req.user!.hodScope, delegation.departmentId, delegation.sectionId))) {
    return res.status(403).json({ error: "An HOD can revoke only its own Section's delegations.", code: "WRONG_SCOPE" });
  }
  const revoked = await prisma.hodDelegation.update({
    where: { id },
    data: { revokedAt: new Date() },
    select: delegationSelect,
  });
  await writeAudit(req.user!.id, "HOD_DELEGATION_REVOKE", "hod_delegation", id, {});
  res.json({ delegation: revoked });
});

/** GET /api/delegations/candidates?departmentId&sectionId — HODs eligible as delegate. */
delegationRouter.get("/candidates", requireRoles("HOD", "PM", "ADMIN"), async (req, res) => {
  const role = req.user!.role;
  const scope = req.user!.hodScope;
  const firstGrant = scope.grants[0];
  const departmentId = Number(req.query.departmentId || req.user!.departmentId || firstGrant?.departmentId || NaN);
  const sectionId = Number(req.query.sectionId || firstGrant?.sectionIds[0] || req.user!.sectionId || NaN);
  if (!departmentId || !sectionId) return res.status(400).json({ error: "departmentId and sectionId are required." });
  if (role === "HOD" && !hodScopeMatchesScope(scope, departmentId, sectionId)) {
    return res.status(403).json({ error: "An HOD can choose a delegate only from a Section they head.", code: "WRONG_SCOPE" });
  }
  const candidates = (await hodsCovering(departmentId, sectionId, req.user!.id)).map((candidate) => ({
    id: candidate.id, name: candidate.name, email: candidate.email, employee: candidate.employee,
  }));
  res.json({ candidates });
});
