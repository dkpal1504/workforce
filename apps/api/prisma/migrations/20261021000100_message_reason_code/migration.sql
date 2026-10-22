-- The cause stamped on the message that reports a delay.
--
-- ADDITIVE and nullable: every existing message stays null, which reads as "no cause recorded" and is
-- excluded from the denominators rather than counted as "other". ON DELETE SET NULL so retiring a code
-- can never delete the message that used it.

ALTER TABLE "job_order_messages" ADD COLUMN     "reason_code" TEXT;

CREATE INDEX "job_order_messages_reason_code_idx" ON "job_order_messages"("reason_code");

ALTER TABLE "job_order_messages" ADD CONSTRAINT "job_order_messages_reason_code_fkey"
  FOREIGN KEY ("reason_code") REFERENCES "delay_reasons"("code") ON DELETE SET NULL ON UPDATE CASCADE;
