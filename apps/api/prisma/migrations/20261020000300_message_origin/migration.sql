-- Where a message was raised from, when not the conversation screen itself (Portfolio row, structure node).
-- ADDITIVE and nullable: existing rows stay null, which is read as "raised in the drawer".

-- AlterTable
ALTER TABLE "job_order_messages" ADD COLUMN     "origin" TEXT;

