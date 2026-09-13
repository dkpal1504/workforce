-- CreateTable
CREATE TABLE "hod_delegations" (
    "id" SERIAL NOT NULL,
    "delegator_id" INTEGER NOT NULL,
    "delegate_user_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,
    "from_date" TIMESTAMP(3) NOT NULL,
    "to_date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" INTEGER,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hod_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hod_delegations_section_id_from_date_to_date_idx" ON "hod_delegations"("section_id", "from_date", "to_date");

-- CreateIndex
CREATE INDEX "hod_delegations_delegator_id_revoked_at_idx" ON "hod_delegations"("delegator_id", "revoked_at");

-- CreateIndex
CREATE INDEX "hod_delegations_delegate_user_id_section_id_idx" ON "hod_delegations"("delegate_user_id", "section_id");

-- AddForeignKey
ALTER TABLE "hod_delegations" ADD CONSTRAINT "hod_delegations_delegator_id_fkey" FOREIGN KEY ("delegator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hod_delegations" ADD CONSTRAINT "hod_delegations_delegate_user_id_fkey" FOREIGN KEY ("delegate_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hod_delegations" ADD CONSTRAINT "hod_delegations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hod_delegations" ADD CONSTRAINT "hod_delegations_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hod_delegations" ADD CONSTRAINT "hod_delegations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

