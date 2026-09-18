import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Demo seed is disabled in production.");
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

  const hull = await prisma.department.create({
    data: { name: "Production - EOU", code: "PRODUCTION_EOU" },
  });
  const blast = await prisma.department.create({
    data: { name: "Production - SEZ", code: "PRODUCTION_SEZ" },
  });
  const repair = await prisma.department.create({
    data: { name: "Shipwright - EOU", code: "SHIPWRIGHT_EOU" },
  });

  const hullSection = await prisma.section.create({
    data: { departmentId: hull.id, name: "Hull Production", code: "HULL", source: "MANUAL" },
  });
  const blastSection = await prisma.section.create({
    data: { departmentId: blast.id, name: "Blasting & Painting", code: "BLAST", source: "MANUAL" },
  });
  const repairSection = await prisma.section.create({
    data: { departmentId: repair.id, name: "Ship Repair", code: "REPAIR", source: "MANUAL" },
  });
  await prisma.costCenter.createMany({
    data: [
      { sectionId: hullSection.id, code: "CC-HULL", name: "Hull Production" },
      { sectionId: blastSection.id, code: "CC-BLAST", name: "Blasting & Painting" },
      { sectionId: repairSection.id, code: "CC-REPAIR", name: "Ship Repair" },
    ],
  });

  const surnames = [
    "Fernandes", "Patil", "Naik", "Kamat", "Desai", "Sawant", "Gomes",
    "Dias", "Pereira", "Rodrigues", "Silva", "Costa", "Menezes", "Almeida",
    "Carvalho", "Pinto", "D'Souza", "Lobo", "Fernandez", "Shaikh",
  ];
  const firstInitials = ["D", "A", "R", "S", "M", "V", "P", "K", "J", "N"];

  const employees = [];
  const supervisorEmployeeIndexes = new Set([0, 5, 6, 13, 16, 17]);
  const payrollEmployeeIndexes = new Set([10, 11, 12]);
  for (let i = 1; i <= 20; i++) {
    const employeeIndex = i - 1;
    const isSupervisor = supervisorEmployeeIndexes.has(employeeIndex);
    const isPayroll = payrollEmployeeIndexes.has(employeeIndex);
    const dept = i <= 13 ? hull : i <= 16 ? blast : repair;
    const emp = await prisma.employee.create({
      data: {
        ecNo: `EC${1000 + i}`,
        name: `Emp ${i} — ${firstInitials[(i - 1) % firstInitials.length]}. ${surnames[(i - 1) % surnames.length]}`,
        departmentId: dept.id,
        designation: isSupervisor ? "Supervisor" : i % 3 === 0 ? "Welder" : i % 3 === 1 ? "Fitter" : "Helper",
        category: isPayroll ? "ON_ROLL" : "CONTRACTOR",
        employmentType: isPayroll ? "PAYROLL" : "CLMS",
      },
    });
    employees.push(emp);
    const sectionId = dept.id === hull.id ? hullSection.id : dept.id === blast.id ? blastSection.id : repairSection.id;
    await prisma.employeeSectionAssignment.create({
      data: { employeeId: emp.id, sectionId, source: "MANUAL" },
    });
  }


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

  const hodUser = await prisma.user.create({
    data: {
      email: "hod@company.com",
      passwordHash,
      name: "HOD User",
      role: "HOD",
      departmentId: hull.id,
      sectionId: hullSection.id,
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

  await prisma.user.create({
    data: {
      email: "employee@company.com",
      passwordHash,
      name: employees[10].name,
      role: "EMPLOYEE",
      departmentId: hull.id,
      employeeId: employees[10].id,
    },
  });

  const supervisors = [
    { email: "sup.a@company.com", name: "V. Kulkarni", deptId: hull.id, employeeIndex: 5 },
    { email: "sup.b@company.com", name: "S. Menon", deptId: hull.id, employeeIndex: 6 },
    { email: "sup.c@company.com", name: "Supervisor C", deptId: blast.id, employeeIndex: 13 },
    { email: "sup.d@company.com", name: "Supervisor D", deptId: repair.id, employeeIndex: 16 },
    { email: "sup.e@company.com", name: "Supervisor E", deptId: repair.id, employeeIndex: 17 },
  ];

  for (const s of supervisors) {
    await prisma.user.create({
      data: {
        email: s.email,
        passwordHash,
        name: s.name,
        role: "SUPERVISOR",
        departmentId: s.deptId,
        employeeId: employees[s.employeeIndex].id,
      },
    });
  }

  // --- UoM master -----------------------------------------------------------
  const uomRows = [
    { code: "NOS", name: "Numbers", example: "Count of pieces, e.g. 12 spools" },
    { code: "MT", name: "Metric Tonne", example: "Weight in tonnes, e.g. 4.5" },
    { code: "SQM", name: "Square Metre", example: "Painted area, e.g. 320" },
    { code: "MTR", name: "Metre", example: "Length in metres, e.g. 18.5" },
  ];
  const uomId: Record<string, number> = {};
  for (const row of uomRows) {
    uomId[row.code] = (await prisma.uom.create({ data: row })).id;
  }

  // --- Projects: ERP Project number + short display colour key --------------
  const projectRows = [
    { code: "PRJ-A", name: "Project A", colorKey: "A", sortOrder: 1, isNonProject: false },
    { code: "PRJ-B", name: "Project B", colorKey: "B", sortOrder: 2, isNonProject: false },
    { code: "PRJ-C", name: "Project C", colorKey: "C", sortOrder: 3, isNonProject: false },
    { code: "PRJ-D", name: "Project D", colorKey: "D", sortOrder: 4, isNonProject: false },
    { code: "PRJ-N", name: "Non Project", colorKey: "N", sortOrder: 5, isNonProject: true },
  ];
  const projectId: Record<string, number> = {};
  for (const row of projectRows) {
    projectId[row.code] = (await prisma.project.create({ data: row })).id;
  }
  const projectFor = (code: string) => projectId[code];

  // --- Networks: validated reference, scoped per project (SAP-fed in phase 2)
  const networkRows = [
    { projectCode: "PRJ-A", code: "SAP-NW-91001", name: "Hull networks" },
    { projectCode: "PRJ-A", code: "SAP-NW-91002", name: "Outfit networks" },
    { projectCode: "PRJ-B", code: "SAP-NW-92001", name: "Block 223 networks" },
    { projectCode: "PRJ-C", code: "SAP-NW-93001", name: "Surface treatment networks" },
    { projectCode: "PRJ-C", code: "SAP-NW-93002", name: "Repair networks" },
    { projectCode: "PRJ-D", code: "SAP-NW-94001", name: "Repair networks" },
    { projectCode: "PRJ-N", code: "DUMMY", name: "Standing / idle hours (no SAP network)" },
  ];
  const networkId: Record<string, number> = {};
  for (const r of networkRows) {
    const created = await prisma.network.create({
      data: { projectId: projectFor(r.projectCode), code: r.code, name: r.name },
    });
    networkId[`${r.projectCode}:${r.code}`] = created.id;
  }

  // --- WBS rows: a WBS only groups Job Orders and carries no budget ---------
  const wbsRows = [
    { projectCode: "PRJ-A", wbsCode: "A.HULL.0010.100", name: "Hull structure", sortOrder: 1 },
    { projectCode: "PRJ-A", wbsCode: "A.OUTF.0020.100", name: "Outfit", sortOrder: 2 },
    { projectCode: "PRJ-B", wbsCode: "B.HULL.0020.150", name: "Block 223", sortOrder: 1 },
    { projectCode: "PRJ-C", wbsCode: "C.SFR.0045.201", name: "Surface treatment", sortOrder: 1 },
    { projectCode: "PRJ-C", wbsCode: "C.REP.0045.202", name: "Repair works", sortOrder: 2 },
    { projectCode: "PRJ-D", wbsCode: "D.REP.0030.110", name: "Repair works", sortOrder: 1 },
    { projectCode: "PRJ-N", wbsCode: "GENERAL", name: "General / Standing", sortOrder: 99 },
  ];
  const wbsId: Record<string, number> = {};
  for (const r of wbsRows) {
    const created = await prisma.projectWbs.create({
      data: { projectId: projectFor(r.projectCode), wbsCode: r.wbsCode, name: r.name, sortOrder: r.sortOrder },
    });
    wbsId[`${r.projectCode}:${r.wbsCode}`] = created.id;
  }

  // --- Job Orders ----------------------------------------------------------
  // The Job Order number repeats ACROSS projects (same activity, same number) and
  // is unique inside one project only. `1900000107` appears in Project A and
  // Project C below on purpose, to exercise that rule.
  // `sectionId` is null only for standing / Non-Project Job Orders, which any
  // section of the department may book.
  type JoSeed = {
    projectCode: string;
    wbsCode: string;
    network: string;
    code: string;
    name: string;
    uom: string;
    qty: number;
    hours: number;
    departmentId: number;
    sectionId: number | null;
    status: "active" | "inactive";
  };
  const joSeeds: JoSeed[] = [
    // Project A — hull structure WBS, all active
    { projectCode: "PRJ-A", wbsCode: "A.HULL.0010.100", network: "SAP-NW-91001", code: "1900000107", name: "Pipe Spool Installation", uom: "NOS", qty: 220, hours: 1200, departmentId: hull.id, sectionId: hullSection.id, status: "active" },
    { projectCode: "PRJ-A", wbsCode: "A.HULL.0010.100", network: "SAP-NW-91001", code: "1900000108", name: "MCB Panel Installation", uom: "NOS", qty: 140, hours: 800, departmentId: hull.id, sectionId: hullSection.id, status: "active" },
    { projectCode: "PRJ-A", wbsCode: "A.HULL.0010.100", network: "SAP-NW-91001", code: "1900000109", name: "Sea Chest Grating Renewal", uom: "SQM", qty: 310, hours: 1500, departmentId: hull.id, sectionId: hullSection.id, status: "active" },
    // Project A — second WBS in the same project
    { projectCode: "PRJ-A", wbsCode: "A.OUTF.0020.100", network: "SAP-NW-91002", code: "1900000114", name: "Accommodation Outfit", uom: "SQM", qty: 480, hours: 950, departmentId: hull.id, sectionId: hullSection.id, status: "active" },
    // Project B — Block 223, one inactive row to demonstrate the status label
    { projectCode: "PRJ-B", wbsCode: "B.HULL.0020.150", network: "SAP-NW-92001", code: "1900000204", name: "Block Transfer (Block 223)", uom: "MT", qty: 640, hours: 2000, departmentId: hull.id, sectionId: hullSection.id, status: "active" },
    { projectCode: "PRJ-B", wbsCode: "B.HULL.0020.150", network: "SAP-NW-92001", code: "1900000205", name: "Block Cleaning (Block 223)", uom: "SQM", qty: 520, hours: 1500, departmentId: hull.id, sectionId: hullSection.id, status: "active" },
    { projectCode: "PRJ-B", wbsCode: "B.HULL.0020.150", network: "SAP-NW-92001", code: "1900000206", name: "Block Painting (Block 223)", uom: "SQM", qty: 700, hours: 1800, departmentId: hull.id, sectionId: hullSection.id, status: "inactive" },
    // Project C — surface treatment, split across two departments
    { projectCode: "PRJ-C", wbsCode: "C.SFR.0045.201", network: "SAP-NW-93001", code: "1900000107", name: "Pipe Spool Installation", uom: "NOS", qty: 220, hours: 900, departmentId: blast.id, sectionId: blastSection.id, status: "active" },
    { projectCode: "PRJ-C", wbsCode: "C.SFR.0045.201", network: "SAP-NW-93001", code: "1900000110", name: "Block Washing", uom: "SQM", qty: 420, hours: 1100, departmentId: blast.id, sectionId: blastSection.id, status: "active" },
    { projectCode: "PRJ-C", wbsCode: "C.SFR.0045.201", network: "SAP-NW-93001", code: "1900000112", name: "Hull Blasting", uom: "SQM", qty: 860, hours: 2000, departmentId: blast.id, sectionId: blastSection.id, status: "inactive" },
    // Project C — repair WBS
    { projectCode: "PRJ-C", wbsCode: "C.REP.0045.202", network: "SAP-NW-93002", code: "1900000111", name: "Propeller & Rudder Inspection", uom: "NOS", qty: 30, hours: 950, departmentId: repair.id, sectionId: repairSection.id, status: "active" },
    // Project D
    { projectCode: "PRJ-D", wbsCode: "D.REP.0030.110", network: "SAP-NW-94001", code: "1900000113", name: "Deck Furniture Installation", uom: "NOS", qty: 90, hours: 600, departmentId: repair.id, sectionId: repairSection.id, status: "active" },
    // Non Project — standing Job Orders at DEPARTMENT level (no section, no cap)
    { projectCode: "PRJ-N", wbsCode: "GENERAL", network: "DUMMY", code: "1900000401", name: "General Housekeeping", uom: "NOS", qty: 0, hours: 0, departmentId: hull.id, sectionId: null, status: "active" },
    { projectCode: "PRJ-N", wbsCode: "GENERAL", network: "DUMMY", code: "1900000402", name: "Administrative / Meeting Time", uom: "NOS", qty: 0, hours: 0, departmentId: hull.id, sectionId: null, status: "active" },
    { projectCode: "PRJ-N", wbsCode: "GENERAL", network: "DUMMY", code: "1900000403", name: "Training & Induction", uom: "NOS", qty: 0, hours: 0, departmentId: hull.id, sectionId: null, status: "active" },
    { projectCode: "PRJ-N", wbsCode: "GENERAL", network: "DUMMY", code: "1900000405", name: "Equipment / Machine Maintenance", uom: "NOS", qty: 0, hours: 0, departmentId: repair.id, sectionId: null, status: "active" },
  ];

  const budgetStart = new Date("2026-01-01");
  const joByKey = new Map<string, number>();
  const joByCode = new Map<string, number>();
  for (const jo of joSeeds) {
    const created = await prisma.jobOrder.create({
      data: {
        projectId: projectFor(jo.projectCode),
        projectWbsId: wbsId[`${jo.projectCode}:${jo.wbsCode}`],
        networkId: networkId[`${jo.projectCode}:${jo.network}`],
        code: jo.code,
        name: jo.name,
        uomId: uomId[jo.uom],
        budgetedQuantity: jo.qty,
        budgetedHours: jo.hours,
        departmentId: jo.departmentId,
        sectionId: jo.sectionId,
        status: jo.status,
      },
    });
    joByKey.set(`${jo.projectCode}:${jo.code}`, created.id);
    if (!joByCode.has(jo.code)) joByCode.set(jo.code, created.id);
    // Revision 1 is the opening budget. Revisions are effective-dated; the PM is
    // the custodian so no approval step is required.
    await prisma.jobOrderBudgetRevision.create({
      data: {
        jobOrderId: created.id,
        revisionNo: 1,
        budgetedHours: jo.hours,
        budgetedQuantity: jo.qty,
        uomId: uomId[jo.uom],
        effectiveFrom: budgetStart,
        reason: "Opening budget",
      },
    });
  }

  // --- Quantity progress: the HOD punches the CUMULATIVE figure, the PM approves
  // A rejected row is kept as history; the correction becomes revision 2.
  const progressSeeds = [
    { projectCode: "PRJ-A", code: "1900000107", date: "2026-09-08", qty: 40, revisionNo: 1, status: "APPROVED", sectionId: hullSection.id },
    { projectCode: "PRJ-A", code: "1900000107", date: "2026-09-10", qty: 95, revisionNo: 1, status: "APPROVED", sectionId: hullSection.id },
    { projectCode: "PRJ-A", code: "1900000107", date: "2026-09-14", qty: 150, revisionNo: 1, status: "SUBMITTED", sectionId: hullSection.id },
    { projectCode: "PRJ-A", code: "1900000108", date: "2026-09-12", qty: 60, revisionNo: 1, status: "SUBMITTED", sectionId: hullSection.id },
    { projectCode: "PRJ-B", code: "1900000204", date: "2026-09-12", qty: 300, revisionNo: 1, status: "APPROVED", sectionId: hullSection.id },
    { projectCode: "PRJ-C", code: "1900000110", date: "2026-09-11", qty: 120, revisionNo: 1, status: "REJECTED", sectionId: blastSection.id },
    { projectCode: "PRJ-C", code: "1900000110", date: "2026-09-11", qty: 96, revisionNo: 2, status: "APPROVED", sectionId: blastSection.id },
  ];
  for (const p of progressSeeds) {
    const rejectionRemark = "Quantity does not match the inspected work";
    const amendmentRemark = "Corrected after the PM rejected revision 1";
    const punchedRemark = p.revisionNo > 1 ? "Re-punched after the inspection" : "Cumulative shift output";
    const latest =
      p.status === "REJECTED" ? rejectionRemark : p.revisionNo > 1 ? amendmentRemark : null;

    const entry = await prisma.jobOrderProgress.create({
      data: {
        jobOrderId: joByKey.get(`${p.projectCode}:${p.code}`)!,
        progressDate: new Date(p.date),
        cumulativeQuantity: p.qty,
        revisionNo: p.revisionNo,
        sectionId: p.sectionId,
        status: p.status,
        punchedById: hodUser.id,
        approvedById: p.status === "APPROVED" ? projectHead.id : null,
        approvedAt: p.status === "APPROVED" ? new Date(p.date) : null,
        // The row keeps the LATEST message; the history below keeps every remark.
        remarks: latest,
      },
    });

    // Every remark is a separate row so a report can show the whole exchange.
    const history: { kind: string; remark: string; authorId: number; authorRole: string }[] = [
      { kind: "PUNCH", remark: punchedRemark, authorId: hodUser.id, authorRole: "HOD" },
    ];
    if (p.status === "REJECTED") {
      history.push({ kind: "REJECT", remark: rejectionRemark, authorId: projectHead.id, authorRole: "PM" });
    } else if (p.revisionNo > 1) {
      history.push({ kind: "AMEND", remark: amendmentRemark, authorId: hodUser.id, authorRole: "HOD" });
    }
    for (const row of history) {
      await prisma.jobOrderProgressRemark.create({ data: { progressId: entry.id, ...row } });
    }
  }
  const rateDate = new Date("2026-01-01");
  await prisma.costRate.createMany({
    data: [
      { category: "ASSOCIATE", ratePerHour: 250, effectiveFrom: rateDate },
      { category: "CONTRACTOR", ratePerHour: 200, effectiveFrom: rateDate },
      { category: "ON_ROLL", ratePerHour: 350, effectiveFrom: rateDate },
    ],
  });

  const sectionByDepartment = new Map<number, number>([
    [hull.id, hullSection.id],
    [blast.id, blastSection.id],
    [repair.id, repairSection.id],
  ]);

  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const yesterdayUtc = new Date(todayUtc);
  yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1);

  const sharmaTeamIndexes = [1, 2, 3, 4, 7];
  for (const employeeIndex of sharmaTeamIndexes) {
    await prisma.dailyTeamSelection.create({
      data: {
        supervisorId: sharma.id,
        employeeId: employees[employeeIndex].id,
        workDate: yesterdayUtc,
        source: "ADDED",
      },
    });
  }

  // Summary demo: realistic daily hours (≤ MAX / OT only with remarks).
  // Old plans used 80–160 entry dumps which inflated Summary totals to 26–34h/day.
  // A Project has many WBS rows, so the demo tags the first WBS of each project.
  const allProjects = await prisma.project.findMany({
    orderBy: { sortOrder: "asc" },
    include: { wbsRows: { orderBy: { sortOrder: "asc" } } },
  });
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
    projectWbsId: number | null;
    projectId: number | null;
    departmentId: number | null;
    sectionId: number | null;
    taggedById: number;
    status: string;
  }[] = [];

  /** Attribution snapshot for a booking row: frozen buckets + project/WBS. */
  const snapshotFor = (project: { id: number; wbsRows: { id: number }[] }, departmentId: number) => ({
    projectWbsId: project.wbsRows[0]?.id ?? null,
    projectId: project.id,
    departmentId,
    sectionId: sectionByDepartment.get(departmentId) ?? null,
  });

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
    if (emp.employmentType !== "CLMS") continue;
    const supervisorsInDepartment = allSupervisors.filter((supervisor) => supervisor.departmentId === emp.departmentId);
    const sup = supervisorsInDepartment[i % supervisorsInDepartment.length];
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
          ...snapshotFor(project, emp.departmentId),
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
        ...snapshotFor(i < 6 ? prjByKey.A : prjByKey.B, emp.departmentId),
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
      const projectIds = [...new Set(opts.slots.map((s) => s.projectId))];
      const slotProjects = await prisma.project.findMany({
        where: { id: { in: projectIds } },
        include: { wbsRows: { orderBy: { sortOrder: "asc" } } },
      });
      const projectById = new Map(slotProjects.map((project) => [project.id, project]));
      await prisma.timesheetEntry.createMany({
        data: opts.slots.map((s) => ({
          timesheetDayId: day.id,
          employeeId: opts.employee.id,
          workDate: opts.workDate,
          hourSlot: s.hourSlot,
          ...snapshotFor(projectById.get(s.projectId)!, opts.employee.departmentId),
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
  for (const employeeIndex of sharmaTeamIndexes) {
    await prisma.dailyTeamSelection.create({
      data: {
        supervisorId: sharma.id,
        employeeId: employees[employeeIndex].id,
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
  console.log(`Employee: EC1011 / ${devPassword}`);
  console.log(`Supervisor: EC1001 / ${devPassword}`);
  console.log(`HOD: hod@company.com / ${devPassword}`);
  console.log(`Project Head: pm@company.com / ${devPassword}`);
  console.log(`Admin: admin@company.com / ${devPassword}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
