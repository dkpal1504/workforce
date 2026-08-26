import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.auditLog.deleteMany();
  await prisma.timesheetEntry.deleteMany();
  await prisma.approval.deleteMany();
  await prisma.timesheetDay.deleteMany();
  await prisma.dailyTeamSelection.deleteMany();
  await prisma.conflict.deleteMany();
  await prisma.manpowerRequest.deleteMany();
  await prisma.attendanceFeed.deleteMany();
  await prisma.costRate.deleteMany();
  await prisma.jobOrder.deleteMany();
  await prisma.project.deleteMany();
  await prisma.projectWbs.deleteMany();
  await prisma.user.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.department.deleteMany();

  const hull = await prisma.department.create({
    data: { name: "Hull Production", code: "HULL" },
  });
  const blast = await prisma.department.create({
    data: { name: "Blasting & Painting", code: "BLAST" },
  });
  const repair = await prisma.department.create({
    data: { name: "Ship Repair", code: "REPAIR" },
  });

  const surnames = [
    "Fernandes", "Patil", "Naik", "Kamat", "Desai", "Sawant", "Gomes",
    "Dias", "Pereira", "Rodrigues", "Silva", "Costa", "Menezes", "Almeida",
    "Carvalho", "Pinto", "D'Souza", "Lobo", "Fernandez", "Shaikh",
  ];
  const firstInitials = ["D", "A", "R", "S", "M", "V", "P", "K", "J", "N"];

  const employees = [];
  for (let i = 1; i <= 20; i++) {
    const dept = i <= 13 ? hull : i <= 16 ? blast : repair;
    const emp = await prisma.employee.create({
      data: {
        ecNo: `EC${1000 + i}`,
        name: `Emp ${i} — ${firstInitials[(i - 1) % firstInitials.length]}. ${surnames[(i - 1) % surnames.length]}`,
        departmentId: dept.id,
        designation: i % 3 === 0 ? "Welder" : i % 3 === 1 ? "Fitter" : "Helper",
        category: i % 3 === 0 ? "ON_ROLL" : i % 3 === 1 ? "ASSOCIATE" : "CONTRACTOR",
      },
    });
    employees.push(emp);
  }

  const passwordHash = await bcrypt.hash("password123", 10);

  const sharma = await prisma.user.create({
    data: {
      email: "r.sharma@company.com",
      passwordHash,
      name: "R. Sharma",
      role: "SUPERVISOR",
      departmentId: hull.id,
      employeeId: employees[0].id,
    },
  });

  await prisma.user.create({
    data: {
      email: "admin@company.com",
      passwordHash,
      name: "System Admin",
      role: "ADMIN",
      departmentId: hull.id,
    },
  });

  await prisma.user.create({
    data: {
      email: "hr@company.com",
      passwordHash,
      name: "HR User",
      role: "HR",
      departmentId: hull.id,
    },
  });

  await prisma.user.create({
    data: {
      email: "hod@company.com",
      passwordHash,
      name: "HOD User",
      role: "HOD",
      departmentId: hull.id,
    },
  });

  const projectHead = await prisma.user.create({
    data: {
      email: "pm@company.com",
      passwordHash,
      name: "Project Head",
      role: "PM",
      departmentId: hull.id,
    },
  });

  await prisma.user.create({
    data: {
      email: "finance@company.com",
      passwordHash,
      name: "Finance User",
      role: "FINANCE",
      departmentId: hull.id,
    },
  });

  const supervisors = [
    { email: "sup.a@company.com", name: "V. Kulkarni", deptId: hull.id },
    { email: "sup.b@company.com", name: "S. Menon", deptId: hull.id },
    { email: "sup.c@company.com", name: "Supervisor C", deptId: blast.id },
    { email: "sup.d@company.com", name: "Supervisor D", deptId: repair.id },
    { email: "sup.e@company.com", name: "Supervisor E", deptId: repair.id },
  ];

  for (const s of supervisors) {
    await prisma.user.create({
      data: {
        email: s.email,
        passwordHash,
        name: s.name,
        role: "SUPERVISOR",
        departmentId: s.deptId,
      },
    });
  }

  const projects = [
    { code: "PRJ-A", name: "Project A", wbsCode: "A.HULL.0010.100", colorKey: "A" },
    { code: "PRJ-B", name: "Project B", wbsCode: "B.HULL.0020.150", colorKey: "B" },
    { code: "PRJ-C", name: "Project C", wbsCode: "C.SFR.0045.201", colorKey: "C" },
    { code: "PRJ-D", name: "Project D", wbsCode: "D.REP.0030.110", colorKey: "D" },
  ];

  for (const p of projects) {
    await prisma.projectWbs.create({ data: p });
  }

  // --- New Project + JobOrder master (1900000xxx codes) ---
  // Used by Job Order Summary tab and (in a later round) by the 4-slot Timesheet Entry.
  const newProjects = [
    { code: "PRJ-A", name: "Project A", colorKey: "A", sortOrder: 1 },
    { code: "PRJ-B", name: "Project B", colorKey: "B", sortOrder: 2 },
    { code: "PRJ-C", name: "Project C", colorKey: "C", sortOrder: 3 },
    { code: "PRJ-D", name: "Project D", colorKey: "D", sortOrder: 4 },
    { code: "PRJ-N", name: "Non Project", colorKey: "N", sortOrder: 5 },
  ];
  const projARow = await prisma.project.create({ data: newProjects[0] });
  const projBRow = await prisma.project.create({ data: newProjects[1] });
  const projCRow = await prisma.project.create({ data: newProjects[2] });
  const projDRow = await prisma.project.create({ data: newProjects[3] });
  const projNRow = await prisma.project.create({ data: newProjects[4] });

  // Link ProjectWbs rows to Project rows so legacy Project Summary stays consistent.
  // The seed_projectWbs objects were just created above; fetch by code.
  const wbsA = await prisma.projectWbs.findUniqueOrThrow({ where: { code: "PRJ-A" } });
  const wbsB = await prisma.projectWbs.findUniqueOrThrow({ where: { code: "PRJ-B" } });
  const wbsC = await prisma.projectWbs.findUniqueOrThrow({ where: { code: "PRJ-C" } });
  const wbsD = await prisma.projectWbs.findUniqueOrThrow({ where: { code: "PRJ-D" } });
  await prisma.project.update({ where: { id: projARow.id }, data: {} });
  // projectWbsId FK on JobOrder points into the legacy ProjectWbs row.

  type JoSeed = {
    projectId: number;
    projectWbsId: number | null;
    code: string;
    name: string;
    departmentId: number;
    budgetedHours: number | null;
    status: "active" | "closed" | "on_hold";
  };
  const joSeeds: JoSeed[] = [
    // Project A — active vessel hull work, all active
    { projectId: projARow.id, projectWbsId: wbsA.id, code: "1900000107", name: "Pipe Spool Installation", departmentId: hull.id, budgetedHours: 1200, status: "active" },
    { projectId: projARow.id, projectWbsId: wbsA.id, code: "1900000108", name: "MCB Panel Installation", departmentId: hull.id, budgetedHours: 800, status: "active" },
    { projectId: projARow.id, projectWbsId: wbsA.id, code: "1900000109", name: "Sea Chest Grating Renewal", departmentId: hull.id, budgetedHours: 1500, status: "active" },
    // Project B — Block 223, active
    { projectId: projBRow.id, projectWbsId: wbsB.id, code: "1900000204", name: "Block Transfer (Block 223)", departmentId: hull.id, budgetedHours: 2000, status: "active" },
    { projectId: projBRow.id, projectWbsId: wbsB.id, code: "1900000205", name: "Block Cleaning (Block 223)", departmentId: hull.id, budgetedHours: 1500, status: "active" },
    { projectId: projBRow.id, projectWbsId: wbsB.id, code: "1900000206", name: "Block Painting (Block 223)", departmentId: hull.id, budgetedHours: 1800, status: "active" },
    // Project C — split across multiple departments
    { projectId: projCRow.id, projectWbsId: wbsC.id, code: "1900000110", name: "Block Washing", departmentId: blast.id, budgetedHours: 1100, status: "active" },
    { projectId: projCRow.id, projectWbsId: wbsC.id, code: "1900000111", name: "Propeller & Rudder Inspection", departmentId: repair.id, budgetedHours: 950, status: "active" },
    { projectId: projCRow.id, projectWbsId: wbsC.id, code: "1900000112", name: "Hull Blasting", departmentId: blast.id, budgetedHours: 2000, status: "closed" },
    // Project D — single active JO, demoing the "CLOSED" superscript on a peer
    { projectId: projDRow.id, projectWbsId: wbsD.id, code: "1900000113", name: "Deck Furniture Installation", departmentId: repair.id, budgetedHours: 600, status: "active" },
    // Non Project — Standing JOs (no budget cap)
    { projectId: projNRow.id, projectWbsId: null, code: "1900000401", name: "General Housekeeping", departmentId: hull.id, budgetedHours: null, status: "active" },
    { projectId: projNRow.id, projectWbsId: null, code: "1900000402", name: "Administrative / Meeting Time", departmentId: hull.id, budgetedHours: null, status: "active" },
    { projectId: projNRow.id, projectWbsId: null, code: "1900000403", name: "Training & Induction", departmentId: hull.id, budgetedHours: null, status: "active" },
    { projectId: projNRow.id, projectWbsId: null, code: "1900000405", name: "Equipment / Machine Maintenance", departmentId: repair.id, budgetedHours: null, status: "active" },
  ];
  const joByCode = new Map<string, number>();
  for (const jo of joSeeds) {
    const created = await prisma.jobOrder.create({ data: jo });
    joByCode.set(jo.code, created.id);
  }

  const rateDate = new Date("2026-01-01");
  await prisma.costRate.createMany({
    data: [
      { category: "ASSOCIATE", ratePerHour: 250, effectiveFrom: rateDate },
      { category: "CONTRACTOR", ratePerHour: 200, effectiveFrom: rateDate },
      { category: "ON_ROLL", ratePerHour: 350, effectiveFrom: rateDate },
    ],
  });

  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const yesterdayUtc = new Date(todayUtc);
  yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1);

  for (let i = 0; i < 5; i++) {
    await prisma.dailyTeamSelection.create({
      data: {
        supervisorId: sharma.id,
        employeeId: employees[i].id,
        workDate: yesterdayUtc,
        source: "ADDED",
      },
    });
  }

  // Summary demo: realistic daily hours (≤ MAX / OT only with remarks).
  // Old plans used 80–160 entry dumps which inflated Summary totals to 26–34h/day.
  const allProjects = await prisma.projectWbs.findMany({ orderBy: { colorKey: "asc" } });
  const allSupervisors = await prisma.user.findMany({
    where: { role: "SUPERVISOR", NOT: { email: "r.sharma@company.com" } },
    orderBy: { name: "asc" },
  });
  const demoDate = todayUtc;
  const prjByKey = Object.fromEntries(allProjects.map((p) => [p.colorKey, p]));

  /** Track distinct slots already used per employee so day total stays realistic. */
  const empSlots = new Map<number, Set<number>>();
  const takeSlots = (employeeId: number, count: number): number[] => {
    let used = empSlots.get(employeeId);
    if (!used) {
      used = new Set();
      empSlots.set(employeeId, used);
    }
    const slots: number[] = [];
    for (let s = 0; s <= 12 && slots.length < count; s++) {
      if (!used.has(s)) {
        used.add(s);
        slots.push(s);
      }
    }
    return slots;
  };

  const dayCache = new Map<string, number>();
  const ensureDay = async (
    employeeId: number,
    supervisorId: number,
    status: string,
    remarks: string | null
  ) => {
    const key = `${employeeId}|${supervisorId}`;
    if (dayCache.has(key)) return dayCache.get(key)!;
    const day = await prisma.timesheetDay.create({
      data: {
        employeeId,
        workDate: demoDate,
        taggedById: supervisorId,
        status,
        remarks,
      },
    });
    dayCache.set(key, day.id);
    return day.id;
  };

  const summaryEntries: {
    timesheetDayId: number;
    employeeId: number;
    workDate: Date;
    hourSlot: number;
    projectWbsId: number;
    taggedById: number;
    status: string;
  }[] = [];

  // Employees 6–19: ~8h each, split across projects, submitted (under cap)
  const patterns: { keys: ("A" | "B" | "C" | "D")[]; hours: number[] }[] = [
    { keys: ["A"], hours: [8] },
    { keys: ["A", "B"], hours: [4, 4] },
    { keys: ["B", "C"], hours: [5, 3] },
    { keys: ["A", "B", "C"], hours: [3, 3, 2] },
    { keys: ["C"], hours: [8] },
    { keys: ["A", "D"], hours: [6, 2] },
  ];

  for (let i = 6; i < employees.length; i++) {
    const emp = employees[i];
    const sup = allSupervisors[i % allSupervisors.length];
    const pattern = patterns[i % patterns.length];
    const dayId = await ensureDay(emp.id, sup.id, "SUBMITTED", null);
    for (let pi = 0; pi < pattern.keys.length; pi++) {
      const project = prjByKey[pattern.keys[pi]];
      const slots = takeSlots(emp.id, pattern.hours[pi]);
      for (const hourSlot of slots) {
        summaryEntries.push({
          timesheetDayId: dayId,
          employeeId: emp.id,
          workDate: demoDate,
          hourSlot,
          projectWbsId: project.id,
          taggedById: sup.id,
          status: "SUBMITTED",
        });
      }
    }
  }

  // One intentional OT sample: 10h with mandatory remarks (supervisor-approved OT reason)
  {
    const emp = employees[19];
    const sup = allSupervisors[0];
    // Drop under-cap rows queued above for this employee
    for (let i = summaryEntries.length - 1; i >= 0; i--) {
      if (summaryEntries[i].employeeId === emp.id) summaryEntries.splice(i, 1);
    }
    empSlots.set(emp.id, new Set());
    const dayId = await ensureDay(
      emp.id,
      sup.id,
      "SUBMITTED",
      "OT: urgent dry-dock handoff — supervisor approved"
    );
    await prisma.timesheetDay.update({
      where: { id: dayId },
      data: { remarks: "OT: urgent dry-dock handoff — supervisor approved" },
    });
    const slots = takeSlots(emp.id, 10);
    for (let i = 0; i < slots.length; i++) {
      summaryEntries.push({
        timesheetDayId: dayId,
        employeeId: emp.id,
        workDate: demoDate,
        hourSlot: slots[i],
        projectWbsId: (i < 6 ? prjByKey.A : prjByKey.B).id,
        taggedById: sup.id,
        status: "SUBMITTED",
      });
    }
  }

  if (summaryEntries.length) {
    await prisma.timesheetEntry.createMany({ data: summaryEntries });
  }

  // Backfill: link legacy hour-slot entries to the first matching JobOrder per
  // ProjectWbs so the new Job Order Summary tab has real consumption numbers.
  // We use the first JO (sorted by code) of each project as the default mapping.
  const wbsToFirstJo = new Map<number, number>();
  const allJOs = await prisma.jobOrder.findMany({ orderBy: [{ projectId: "asc" }, { code: "asc" }] });
  for (const jo of allJOs) {
    if (jo.projectWbsId != null && !wbsToFirstJo.has(jo.projectWbsId)) {
      wbsToFirstJo.set(jo.projectWbsId, jo.id);
    }
  }
  for (const [wbsId, joId] of wbsToFirstJo) {
    await prisma.timesheetEntry.updateMany({
      where: { projectWbsId: wbsId, jobOrderId: null, hourSlot: { not: null } },
      data: { jobOrderId: joId },
    });
  }

  // --- HOD approval demo: structured Project A/B/C (+ overhead on D) ---
  const prjA = allProjects.find((p) => p.colorKey === "A")!;
  const prjB = allProjects.find((p) => p.colorKey === "B")!;
  const prjC = allProjects.find((p) => p.colorKey === "C")!;
  const prjD = allProjects.find((p) => p.colorKey === "D")!;
  const kulkarni = allSupervisors.find((s) => s.name === "V. Kulkarni")!;
  const menon = allSupervisors.find((s) => s.name === "S. Menon")!;
  const hodUser = await prisma.user.findUniqueOrThrow({ where: { email: "hod@company.com" } });

  const fiveDaysAgo = new Date(demoDate);
  fiveDaysAgo.setUTCDate(fiveDaysAgo.getUTCDate() - 5);

  async function seedEmployeeDay(opts: {
    supervisorId: number;
    employee: (typeof employees)[0];
    status: string;
    workDate: Date;
    backdatedAt?: Date;
    slots: { projectId: number; hourSlot: number }[];
    remarks?: string;
  }) {
    const existing = await prisma.timesheetDay.findUnique({
      where: {
        employeeId_workDate_taggedById: {
          employeeId: opts.employee.id,
          workDate: opts.workDate,
          taggedById: opts.supervisorId,
        },
      },
    });
    if (existing) {
      await prisma.timesheetEntry.deleteMany({ where: { timesheetDayId: existing.id } });
      await prisma.approval.deleteMany({ where: { timesheetDayId: existing.id } });
      await prisma.timesheetDay.delete({ where: { id: existing.id } });
    }

    const day = await prisma.timesheetDay.create({
      data: {
        employeeId: opts.employee.id,
        workDate: opts.workDate,
        taggedById: opts.supervisorId,
        status: opts.status,
        remarks: opts.remarks ?? null,
      },
    });
    if (opts.slots.length) {
      await prisma.timesheetEntry.createMany({
        data: opts.slots.map((s) => ({
          timesheetDayId: day.id,
          employeeId: opts.employee.id,
          workDate: opts.workDate,
          hourSlot: s.hourSlot,
          projectWbsId: s.projectId,
          taggedById: opts.supervisorId,
          status: opts.status,
        })),
      });
    }
    if (opts.backdatedAt) {
      await prisma.$executeRawUnsafe(
        `UPDATE timesheet_days SET created_at = ?, updated_at = ? WHERE id = ?`,
        opts.backdatedAt.toISOString(),
        opts.backdatedAt.toISOString(),
        day.id
      );
    }
    return day;
  }

  // R. Sharma — expandable group matching screenshot shape
  await seedEmployeeDay({
    supervisorId: sharma.id,
    employee: employees[0],
    status: "SUBMITTED",
    workDate: demoDate,
    backdatedAt: fiveDaysAgo,
    slots: [
      { projectId: prjA.id, hourSlot: 0 },
      { projectId: prjA.id, hourSlot: 1 },
      { projectId: prjA.id, hourSlot: 2 },
      { projectId: prjA.id, hourSlot: 3 },
      { projectId: prjB.id, hourSlot: 4 },
      { projectId: prjB.id, hourSlot: 5 },
      { projectId: prjC.id, hourSlot: 6 },
      { projectId: prjC.id, hourSlot: 7 },
    ],
  });
  await seedEmployeeDay({
    supervisorId: sharma.id,
    employee: employees[1],
    status: "SUBMITTED",
    workDate: demoDate,
    backdatedAt: fiveDaysAgo,
    slots: [
      { projectId: prjA.id, hourSlot: 0 },
      { projectId: prjA.id, hourSlot: 1 },
      { projectId: prjA.id, hourSlot: 2 },
      { projectId: prjA.id, hourSlot: 3 },
      { projectId: prjB.id, hourSlot: 4 },
      { projectId: prjB.id, hourSlot: 5 },
      { projectId: prjB.id, hourSlot: 6 },
      { projectId: prjB.id, hourSlot: 7 },
    ],
  });

  // V. Kulkarni — conflict (same employee also tagged by Menon) + overhead hour
  await seedEmployeeDay({
    supervisorId: kulkarni.id,
    employee: employees[2],
    status: "SUBMITTED",
    workDate: demoDate,
    backdatedAt: fiveDaysAgo,
    slots: [
      { projectId: prjA.id, hourSlot: 0 },
      { projectId: prjA.id, hourSlot: 1 },
      { projectId: prjB.id, hourSlot: 2 },
      { projectId: prjB.id, hourSlot: 3 },
      { projectId: prjC.id, hourSlot: 4 },
      { projectId: prjC.id, hourSlot: 5 },
      { projectId: prjD.id, hourSlot: 6 },
    ],
    remarks: "Conflict demo — dual tagging",
  });
  await seedEmployeeDay({
    supervisorId: menon.id,
    employee: employees[2],
    status: "SUBMITTED",
    workDate: demoDate,
    backdatedAt: fiveDaysAgo,
    slots: [
      { projectId: prjA.id, hourSlot: 8 },
      { projectId: prjA.id, hourSlot: 9 },
    ],
  });

  // Already HOD-approved → waiting for Project Head
  const hodApprovedDay = await seedEmployeeDay({
    supervisorId: menon.id,
    employee: employees[3],
    status: "HOD_APPROVED",
    workDate: demoDate,
    slots: [
      { projectId: prjA.id, hourSlot: 0 },
      { projectId: prjA.id, hourSlot: 1 },
      { projectId: prjA.id, hourSlot: 2 },
      { projectId: prjB.id, hourSlot: 3 },
      { projectId: prjB.id, hourSlot: 4 },
      { projectId: prjC.id, hourSlot: 5 },
      { projectId: prjC.id, hourSlot: 6 },
      { projectId: prjC.id, hourSlot: 7 },
    ],
  });
  await prisma.approval.create({
    data: {
      timesheetDayId: hodApprovedDay.id,
      approverId: hodUser.id,
      action: "APPROVE",
      comment: "Looks good — forwarding to Project Head",
    },
  });

  // Planning returned → HOD "Sent Back by Planning"
  const returnedDay = await seedEmployeeDay({
    supervisorId: sharma.id,
    employee: employees[4],
    status: "PLANNING_RETURNED",
    workDate: yesterdayUtc,
    slots: [
      { projectId: prjA.id, hourSlot: 0 },
      { projectId: prjA.id, hourSlot: 1 },
      { projectId: prjA.id, hourSlot: 2 },
      { projectId: prjA.id, hourSlot: 3 },
      { projectId: prjD.id, hourSlot: 4 },
      { projectId: prjD.id, hourSlot: 5 },
    ],
  });
  await prisma.approval.create({
    data: {
      timesheetDayId: returnedDay.id,
      approverId: hodUser.id,
      action: "APPROVE",
      comment: "Approved to Project Head",
    },
  });
  await prisma.approval.create({
    data: {
      timesheetDayId: returnedDay.id,
      approverId: projectHead.id,
      action: "PLANNING_RETURN",
      comment: "WBS mismatch — confirm job order for Project A",
    },
  });

  const returnedDay2 = await seedEmployeeDay({
    supervisorId: kulkarni.id,
    employee: employees[5],
    status: "PLANNING_RETURNED",
    workDate: yesterdayUtc,
    slots: [
      { projectId: prjB.id, hourSlot: 0 },
      { projectId: prjB.id, hourSlot: 1 },
      { projectId: prjB.id, hourSlot: 2 },
      { projectId: prjB.id, hourSlot: 3 },
      { projectId: prjB.id, hourSlot: 4 },
      { projectId: prjB.id, hourSlot: 5 },
      { projectId: prjB.id, hourSlot: 6 },
      { projectId: prjB.id, hourSlot: 7 },
      { projectId: prjB.id, hourSlot: 8 },
    ],
    remarks: "OT beyond daily cap",
  });
  await prisma.approval.create({
    data: {
      timesheetDayId: returnedDay2.id,
      approverId: projectHead.id,
      action: "PLANNING_RETURN",
      comment: "Overhead hours exceed daily cap — please review.",
    },
  });

  // Supervisor inbox demo: HOD rejected / sent back to R. Sharma (needs correction + resubmit)
  for (let i = 0; i < 5; i++) {
    await prisma.dailyTeamSelection.create({
      data: {
        supervisorId: sharma.id,
        employeeId: employees[i].id,
        workDate: demoDate,
        source: "CARRIED_OVER",
      },
    });
  }

  const rejectedForSup = await seedEmployeeDay({
    supervisorId: sharma.id,
    employee: employees[3],
    status: "REJECTED",
    workDate: demoDate,
    slots: [
      { projectId: prjA.id, hourSlot: 0 },
      { projectId: prjA.id, hourSlot: 1 },
      { projectId: prjA.id, hourSlot: 2 },
      { projectId: prjB.id, hourSlot: 3 },
      { projectId: prjB.id, hourSlot: 4 },
      { projectId: prjC.id, hourSlot: 5 },
      { projectId: prjC.id, hourSlot: 6 },
      { projectId: prjC.id, hourSlot: 7 },
    ],
    remarks: null,
  });
  await prisma.approval.create({
    data: {
      timesheetDayId: rejectedForSup.id,
      approverId: hodUser.id,
      action: "REJECT",
      comment: "Project C hours look high vs attendance — please recheck tagging and resubmit.",
    },
  });

  console.log("Seed complete.");
  console.log("Login: r.sharma@company.com / password123");
  console.log("HOD: hod@company.com / password123");
  console.log("Project Head: pm@company.com / password123");
  console.log("Admin: admin@company.com / password123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
