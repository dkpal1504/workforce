/* Safe, idempotent bridge for databases historically managed by `prisma db push`.
 * Run through npm scripts only. It snapshots legacy identity/org values before
 * Prisma removes obsolete columns, then restores them into the normalized model.
 */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('Usage: node master-data-upgrade.cjs before|after');

function databasePath() {
  const url = (process.env.DATABASE_URL || 'file:./dev.db').replace(/^['"]|['"]$/g, '');
  if (!url.startsWith('file:')) throw new Error('Master-data upgrade supports SQLite file: DATABASE_URL only.');
  const raw = url.slice(5).split('?')[0];
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw);
}
function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function columns(db, table) {
  return tableExists(db, table) ? new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(r => r.name)) : new Set();
}
function norm(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
function code(value) { return norm(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UNASSIGNED'; }

const dbPath = databasePath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const statePath = `${dbPath}.master-data-upgrade-state.json`;

if (phase === 'before') {
  if (fs.existsSync(statePath)) {
    console.log(`[master-data-upgrade] Reusing protected upgrade state: ${statePath}`);
    process.exit(0);
  }
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, org: [], overrides: [] }));
    process.exit(0);
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+/, '');
  const backupPath = path.join(path.dirname(dbPath), `${path.basename(dbPath, '.db')}-pre-master-data-${stamp}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON');
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const quotedBackup = backupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${quotedBackup}'`);
  if (integrity !== 'ok') throw new Error(`Database integrity check failed: ${integrity}`);
  const backupSha256 = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
  if (tableExists(db, 'contract_workers')) {
    const legacyContractWorkers = db.prepare('SELECT COUNT(*) count FROM contract_workers').get().count;
    if (legacyContractWorkers > 0) throw new Error(`Refusing to drop ${legacyContractWorkers} legacy ContractWorker rows. Reconcile them into canonical Employee records first.`);
  }
  const employeeCols = columns(db, 'employees');
  const userCols = columns(db, 'users');
  const org = [];
  if (employeeCols.has('plant') && employeeCols.has('section')) {
    const rows = db.prepare(`SELECT e.id employeeId,e.source,e.plant,e.section,e.nature_of_work natureOfWork,d.name oldDepartment
      FROM employees e JOIN departments d ON d.id=e.department_id WHERE e.source='SYNC'`).all();
    for (const row of rows) {
      const division = norm(row.plant);
      const oldDepartment = norm(row.oldDepartment);
      if (!oldDepartment || !division) continue;
      const departmentName = `${oldDepartment} - ${division}`;
      const sectionName = norm(row.section);
      org.push({ employeeId: row.employeeId, departmentName, departmentCode: code(departmentName), sectionName, sectionCode: code(sectionName), naturalSupervisor: norm(row.natureOfWork).toLowerCase() === 'supervisor' });
    }
  }
  const overrides = [];
  if (tableExists(db, 'supervisor_pins') && employeeCols.has('id_card_no')) {
    for (const row of db.prepare(`SELECT p.id_card_no idCardNo,p.created_by createdBy,p.created_at createdAt,e.id employeeId
      FROM supervisor_pins p LEFT JOIN employees e ON e.id_card_no=p.id_card_no`).all()) {
      if (!row.employeeId) throw new Error(`Legacy supervisor pin ${row.idCardNo} has no Employee match.`);
      overrides.push({ employeeId: row.employeeId, createdById: row.createdBy || null, createdAt: row.createdAt || null });
    }
  }
  if (employeeCols.has('id_card_no')) {
    const collisions = db.prepare(`SELECT e.id,e.id_card_no,other.id other_id,other.ec_no FROM employees e JOIN employees other
      ON UPPER(TRIM(other.ec_no))=UPPER(TRIM(e.id_card_no)) AND other.id<>e.id
      WHERE e.source='SYNC' AND e.id_card_no IS NOT NULL AND TRIM(e.id_card_no)<>''`).all();
    if (collisions.length) throw new Error(`Raw CLMS ecNo collisions detected: ${JSON.stringify(collisions.slice(0, 10))}`);
    db.exec(`UPDATE employees SET ec_no=TRIM(id_card_no) WHERE source='SYNC' AND id_card_no IS NOT NULL AND TRIM(id_card_no)<>''`);
    if (userCols.has('id_card_no') && userCols.has('employee_id')) {
      db.exec(`UPDATE users SET employee_id=(SELECT e.id FROM employees e WHERE e.id_card_no=users.id_card_no)
        WHERE employee_id IS NULL AND id_card_no IS NOT NULL AND EXISTS(SELECT 1 FROM employees e WHERE e.id_card_no=users.id_card_no)`);
    }
  }
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, backupPath, backupSha256, org, overrides }, null, 2), { mode: 0o600 });
  db.close();
  console.log(`[master-data-upgrade] Backup: ${backupPath} (sha256 ${backupSha256})`);
  console.log(`[master-data-upgrade] Prepared ${org.length} CLMS org mappings and ${overrides.length} overrides.`);
  process.exit(0);
}

if (!fs.existsSync(statePath)) {
  console.log('[master-data-upgrade] No legacy state to restore.');
  process.exit(0);
}
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON');
const insertDept = db.prepare(`INSERT INTO departments(name,code,source,active,created_at) VALUES(?,?, 'SYNC',1,CURRENT_TIMESTAMP)`);
const findDeptByCode = db.prepare(`SELECT id,name FROM departments WHERE code=?`);
const insertSection = db.prepare(`INSERT INTO sections(department_id,code,name,source,active,created_at,updated_at) VALUES(?,?,?,'SYNC',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
const findSection = db.prepare(`SELECT id FROM sections WHERE department_id=? AND code=?`);
const updateEmployee = db.prepare(`UPDATE employees SET department_id=?,employment_type='CLMS' WHERE id=?`);
const upsertAssignmentInsert = db.prepare(`INSERT INTO employee_section_assignments(employee_id,section_id,source,created_at,updated_at) VALUES(?,?,'SYNC',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT(employee_id) DO UPDATE SET section_id=excluded.section_id,source='SYNC',updated_at=CURRENT_TIMESTAMP`);
const existingAssignment = db.prepare(`SELECT esa.id,s.department_id departmentId,esa.source FROM employee_section_assignments esa JOIN sections s ON s.id=esa.section_id WHERE esa.employee_id=?`);
const clearInvalidSupervisorAssignment = db.prepare(`DELETE FROM employee_section_assignments WHERE employee_id=?`);
const insertOverride = db.prepare(`INSERT INTO supervisor_overrides(employee_id,created_by,reason,revoked_at,created_at,updated_at) VALUES(?,?,'Migrated legacy supervisor pin',NULL,COALESCE(?,CURRENT_TIMESTAMP),CURRENT_TIMESTAMP)
  ON CONFLICT(employee_id) DO NOTHING`);

db.exec('BEGIN IMMEDIATE');
try {
  for (const item of state.org || []) {
    let dept = findDeptByCode.get(item.departmentCode);
    if (!dept) { insertDept.run(item.departmentName, item.departmentCode); dept = findDeptByCode.get(item.departmentCode); }
    else if (norm(dept.name).toLowerCase() !== norm(item.departmentName).toLowerCase()) throw new Error(`Department code collision ${item.departmentCode}: ${dept.name} vs ${item.departmentName}`);
    updateEmployee.run(dept.id, item.employeeId);
    if (item.sectionName) {
      let section = findSection.get(dept.id, item.sectionCode);
      if (!section) { insertSection.run(dept.id, item.sectionCode, item.sectionName); section = findSection.get(dept.id, item.sectionCode); }
      const assignment = existingAssignment.get(item.employeeId);
      if (item.naturalSupervisor) {
        if (assignment && assignment.departmentId !== dept.id) clearInvalidSupervisorAssignment.run(item.employeeId);
      } else {
        upsertAssignmentInsert.run(item.employeeId, section.id);
      }
    }
  }
  for (const item of state.overrides || []) insertOverride.run(item.employeeId, item.createdById, item.createdAt);
  db.exec(`UPDATE users SET department_id=(SELECT e.department_id FROM employees e WHERE e.id=users.employee_id)
    WHERE employee_id IS NOT NULL`);
  db.exec(`UPDATE employees SET employment_type=CASE WHEN source='SYNC' THEN 'CLMS' ELSE 'PAYROLL' END`);
  db.exec(`UPDATE employees SET terminated_at=COALESCE(terminated_at,CURRENT_TIMESTAMP) WHERE source='SYNC' AND active=0`);
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
const fk = db.prepare('PRAGMA foreign_key_check').all();
db.close();
if (integrity !== 'ok' || fk.length) throw new Error(`Post-upgrade verification failed: integrity=${integrity}, fk=${JSON.stringify(fk.slice(0, 10))}`);
fs.unlinkSync(statePath);
console.log(`[master-data-upgrade] Restored normalized organization mappings. Integrity: ${integrity}.`);
