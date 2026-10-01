import test from "node:test";
import assert from "node:assert/strict";
import {
  accountSourceOf,
  isAppOwnedAccount,
  shouldReopenSupervisorAccount,
  shouldWithdrawSupervisorRole,
  supervisorAccountTransition,
  syncOwnsSupervisorRoster,
} from "./supervisorAccountLifecycle";

/**
 * The production case this module was written for:
 *   user 34, ecNo BAPL0085, users.source = MANUAL, role SUPERVISOR, active = false
 *   employees.source = SYNC, employment_type = CLMS, active = TRUE, nature_of_work = "Office Assistant"
 *   -> the sync disabled the login on every tick and could never re-enable it.
 */
const promotedContractSupervisor = {
  accountSource: "MANUAL",
  employeeActive: true,
  accountActive: false,
  role: "SUPERVISOR",
} as const;

test("an app-owned supervisor login is NOT withdrawn because NatureOfWork is not Supervisor", () => {
  // The bug: this returned true, so the login was closed on every run of the sync.
  assert.equal(shouldWithdrawSupervisorRole(promotedContractSupervisor), false);
});

test("an app-owned supervisor login IS re-opened while the employee is active", () => {
  assert.equal(shouldReopenSupervisorAccount(promotedContractSupervisor), true);
  assert.deepEqual(supervisorAccountTransition(promotedContractSupervisor), {
    change: true,
    active: true,
    reason: "Account re-opened: employee is active in the source.",
  });
});

test("a LabourWorks-owned supervisor keeps the old behaviour, withdrawal included", () => {
  const syncOwned = { accountSource: "SYNC", employeeActive: true, accountActive: true, role: "SUPERVISOR" } as const;
  assert.equal(shouldWithdrawSupervisorRole(syncOwned), true);
  // A SYNC account is never re-opened by this rule: LabourWorks is the authority for it, and a
  // SYNC account that is active but closed is handled by the eligibility branch exactly as before.
  assert.equal(shouldReopenSupervisorAccount(syncOwned), false);
  assert.deepEqual(supervisorAccountTransition(syncOwned), {
    change: true,
    active: false,
    reason: "Supervisor eligibility removed.",
  });
});

test("termination still disables an account of ANY source — the fix must not weaken it", () => {
  const appOwnedTerminated = { accountSource: "MANUAL", employeeActive: false, accountActive: true, role: "SUPERVISOR" } as const;
  const syncOwnedTerminated = { accountSource: "SYNC", employeeActive: false, accountActive: true, role: "SUPERVISOR" } as const;
  // Neither rule fires: the caller's `!employee.active` branch (source IsTerminated / absence sweep)
  // is what closes these, and it is deliberately not modelled here.
  assert.equal(shouldWithdrawSupervisorRole(appOwnedTerminated), false);
  assert.equal(shouldReopenSupervisorAccount(appOwnedTerminated), false);
  assert.deepEqual(supervisorAccountTransition(appOwnedTerminated), { change: false });
  assert.deepEqual(supervisorAccountTransition(syncOwnedTerminated), { change: false });
});

test("a non-supervisor role is never touched by the supervisor roster rules", () => {
  for (const role of ["EMPLOYEE", "HOD", "PM", "ADMIN", "HR", "FINANCE", "DEPT_HEAD"]) {
    const context = { accountSource: "MANUAL", employeeActive: true, accountActive: false, role };
    assert.deepEqual(supervisorAccountTransition(context), { change: false }, `role ${role} must be left alone`);
  }
});

test("an app-owned supervisor that is already active is not written again", () => {
  const alreadyActive = { accountSource: "MANUAL", employeeActive: true, accountActive: true, role: "SUPERVISOR" } as const;
  assert.deepEqual(supervisorAccountTransition(alreadyActive), { change: false });
});

test("PAYROLL is app-owned too — the same rule covers a registered payroll supervisor", () => {
  const payroll = { accountSource: "PAYROLL", employeeActive: true, accountActive: false, role: "SUPERVISOR" } as const;
  assert.equal(isAppOwnedAccount("PAYROLL"), true);
  assert.equal(shouldReopenSupervisorAccount(payroll), true);
});

test("source comparison is trimmed and case-insensitive, and an unknown source is app-owned", () => {
  assert.equal(accountSourceOf(" sync "), "SYNC");
  assert.equal(syncOwnsSupervisorRoster(" sync "), true);
  assert.equal(syncOwnsSupervisorRoster("Sync"), true);
  // Fail SAFE: an unrecognised or missing source must not be treated as sync-owned, because that is
  // the reading that lets the sync close an account nothing can re-open.
  assert.equal(syncOwnsSupervisorRoster(null), false);
  assert.equal(syncOwnsSupervisorRoster(undefined), false);
  assert.equal(syncOwnsSupervisorRoster(""), false);
  assert.equal(isAppOwnedAccount(null), true);
});
