-- The clock on a message, and the reply that stops it.
--
-- ADDITIVE and nullable. `answers_message_id` is set ONCE, on the reply, so "responded in 6 h" stays true
-- even after the thread grows; `ladder_step` marks the SYSTEM line a rung wrote, which is what makes a
-- sweep run twice harmless.

ALTER TABLE "job_order_messages" ADD COLUMN     "response_due_at" TIMESTAMP(3),
ADD COLUMN     "answers_message_id" INTEGER,
ADD COLUMN     "ladder_step" TEXT;

CREATE INDEX "job_order_messages_response_due_at_answers_message_id_idx"
  ON "job_order_messages"("response_due_at", "answers_message_id");

ALTER TABLE "job_order_messages" ADD CONSTRAINT "job_order_messages_answers_message_id_fkey"
  FOREIGN KEY ("answers_message_id") REFERENCES "job_order_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
