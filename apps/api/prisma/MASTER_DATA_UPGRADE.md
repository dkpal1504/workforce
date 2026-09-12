# Canonical Employee master-data upgrade

The installed SQLite databases were historically managed with `prisma db push`; their migration-table lineage is not a reliable deployment source. Use the guarded bridge:

```bash
npm run db:migrate -w @workforce/api
```

The command performs these steps:

1. Runs `PRAGMA integrity_check` and creates a consistent `VACUUM INTO` backup.
2. Prints the backup SHA-256.
3. Aborts on canonical `ecNo` collisions or unreconciled legacy `ContractWorker` rows.
4. Captures legacy CLMS identity, Division, Section, and supervisor overrides.
5. Applies the reviewed Prisma schema with `db push --accept-data-loss`.
6. Restores `IDCardNo` as canonical `ecNo`, combined `BuName - Division` Departments, scoped Sections, Employee assignments, linked User Departments, and overrides.
7. Runs integrity and foreign-key checks before deleting the protected upgrade-state file.

If schema application fails, keep the `*.master-data-upgrade-state.json` file and the printed backup. Correct the cause and rerun the command. Never delete the backup until application verification is complete.

## Required post-upgrade operations

- Configure the read-only LabourWorks and SMTP variables documented in `.env.example`.
- Keep `BADGEVIEW_SYNC_ENABLED=false` until a manual sync result is reviewed.
- Configure Cost Centers for Sections that need them.
- In **Organisation → Job Order Mapping**, explicitly map every Job Order to an active combined Department. Assignment APIs intentionally reject unmapped/legacy Department Job Orders. Division choices are not guessed by the upgrade.
- Review `sync_exceptions` after every initial sync. Mobile conflicts are never auto-merged.
