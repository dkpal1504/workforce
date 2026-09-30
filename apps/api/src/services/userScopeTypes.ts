/**
 * The refusal shape shared by the scope rules.
 *
 * In its own module so `userScope.ts` stays a pure leaf: a router or a type-only import must not
 * drag in the database layer just to name a refusal.
 */
export type ScopeRefusal = { code: string; error: string };
