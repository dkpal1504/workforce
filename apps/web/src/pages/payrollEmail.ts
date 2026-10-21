/**
 * The address shown for a payroll employee, and whether it is a mailbox at all.
 *
 * PAYROLL accounts are created two ways: a registration form that captures a real address, and the CSV
 * import that writes `40032200@employee.local` so the person can SIGN IN. The second is a login name,
 * not a mailbox — nothing can be delivered to it — and it is the majority of this data (65 of 89).
 *
 * The screen exists to make that distinction visible, so the rule lives here, tested, rather than in a
 * JSX expression where "looks like an address" and "is an address" silently become the same thing.
 */

export type PayrollAddress = {
  /** The address to print. Empty when neither field carries anything. */
  address: string;
  /** True for an `@employee.local` handle: printable, but not deliverable. */
  placeholder: boolean;
  /** A second line when the login differs from the address a person actually reads. */
  secondary: string | null;
};

export type AddressFields = {
  email?: string | null;
  notificationEmail?: string | null;
};

export function payrollEmail(employee: AddressFields): PayrollAddress {
  const notification = employee.notificationEmail?.trim() ?? "";
  const login = employee.email?.trim() ?? "";
  const address = notification || login;

  if (!address) return { address: "", placeholder: false, secondary: null };

  const placeholder = address.toLowerCase().endsWith("@employee.local");
  const secondary = notification && login && notification !== login ? `login: ${login}` : null;

  return { address, placeholder, secondary };
}
