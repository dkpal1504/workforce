-- Job Order conversations (docs/plans/2026-10-19-job-order-conversations.md).
--
-- ADDITIVE ONLY: nine new tables with their indexes and foreign keys, plus four nullable
-- columns on existing tables (job_orders.owner_user_id / owner_assigned_by /
-- owner_assigned_at, users.notification_email). No existing row is read or rewritten and no
-- column is dropped, so the release can ship the same way as the previous one and rolling the
-- code back leaves the new tables inert.

-- AlterTable
ALTER TABLE "job_orders" ADD COLUMN     "owner_assigned_at" TIMESTAMP(3),
ADD COLUMN     "owner_assigned_by" INTEGER,
ADD COLUMN     "owner_user_id" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notification_email" TEXT;

-- CreateTable
CREATE TABLE "job_order_threads" (
    "id" SERIAL NOT NULL,
    "job_order_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "opened_by" INTEGER,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by" INTEGER,
    "resolved_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_by" INTEGER,
    "message_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "job_order_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_order_messages" (
    "id" SERIAL NOT NULL,
    "thread_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "author_user_id" INTEGER,
    "author_email" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "author_role" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'APP',
    "body" TEXT NOT NULL,
    "body_revision" INTEGER NOT NULL DEFAULT 1,
    "edited_at" TIMESTAMP(3),
    "edited_by" INTEGER,
    "reply_to_id" INTEGER,
    "context_json" TEXT,
    "proposal_json" TEXT,
    "escalation_due_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_email" TEXT,
    "ip_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_order_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_order_thread_participants" (
    "id" SERIAL NOT NULL,
    "thread_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "email" TEXT NOT NULL,
    "role_at_join" TEXT NOT NULL,
    "added_by" INTEGER,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "muted_at" TIMESTAMP(3),
    "last_read_at" TIMESTAMP(3),

    CONSTRAINT "job_order_thread_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_order_message_recipients" (
    "id" SERIAL NOT NULL,
    "message_id" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "user_id" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "sent_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "job_order_message_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_order_reply_tokens" (
    "id" SERIAL NOT NULL,
    "token_hash" TEXT NOT NULL,
    "thread_id" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "user_id" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "job_order_reply_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_order_commitments" (
    "id" SERIAL NOT NULL,
    "thread_id" INTEGER NOT NULL,
    "message_id" INTEGER NOT NULL,
    "job_order_id" INTEGER NOT NULL,
    "owner_email" TEXT NOT NULL,
    "owner_user_id" INTEGER,
    "due_on" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "resolved_at" TIMESTAMP(3),
    "chased_at" TIMESTAMP(3),

    CONSTRAINT "job_order_commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_usage" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "job_order_id" INTEGER,
    "thread_id" INTEGER,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "outcome" TEXT NOT NULL,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_order_threads_job_order_id_key" ON "job_order_threads"("job_order_id");

-- CreateIndex
CREATE INDEX "job_order_threads_status_last_message_at_idx" ON "job_order_threads"("status", "last_message_at");

-- CreateIndex
CREATE INDEX "job_order_messages_thread_id_created_at_idx" ON "job_order_messages"("thread_id", "created_at");

-- CreateIndex
CREATE INDEX "job_order_messages_kind_escalation_due_at_idx" ON "job_order_messages"("kind", "escalation_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_order_messages_thread_id_seq_key" ON "job_order_messages"("thread_id", "seq");

-- CreateIndex
CREATE INDEX "job_order_thread_participants_user_id_idx" ON "job_order_thread_participants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_order_thread_participants_thread_id_email_key" ON "job_order_thread_participants"("thread_id", "email");

-- CreateIndex
CREATE INDEX "job_order_message_recipients_message_id_idx" ON "job_order_message_recipients"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_order_reply_tokens_token_hash_key" ON "job_order_reply_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "job_order_reply_tokens_thread_id_email_idx" ON "job_order_reply_tokens"("thread_id", "email");

-- CreateIndex
CREATE INDEX "job_order_commitments_state_due_on_idx" ON "job_order_commitments"("state", "due_on");

-- CreateIndex
CREATE INDEX "job_order_commitments_job_order_id_idx" ON "job_order_commitments"("job_order_id");

-- CreateIndex
CREATE INDEX "assistant_usage_action_created_at_idx" ON "assistant_usage"("action", "created_at");

-- AddForeignKey
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_threads" ADD CONSTRAINT "job_order_threads_job_order_id_fkey" FOREIGN KEY ("job_order_id") REFERENCES "job_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_threads" ADD CONSTRAINT "job_order_threads_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_threads" ADD CONSTRAINT "job_order_threads_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_threads" ADD CONSTRAINT "job_order_threads_last_message_by_fkey" FOREIGN KEY ("last_message_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_messages" ADD CONSTRAINT "job_order_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "job_order_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_messages" ADD CONSTRAINT "job_order_messages_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_messages" ADD CONSTRAINT "job_order_messages_edited_by_fkey" FOREIGN KEY ("edited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_messages" ADD CONSTRAINT "job_order_messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "job_order_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_thread_participants" ADD CONSTRAINT "job_order_thread_participants_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "job_order_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_thread_participants" ADD CONSTRAINT "job_order_thread_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_thread_participants" ADD CONSTRAINT "job_order_thread_participants_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_message_recipients" ADD CONSTRAINT "job_order_message_recipients_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "job_order_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_reply_tokens" ADD CONSTRAINT "job_order_reply_tokens_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "job_order_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_reply_tokens" ADD CONSTRAINT "job_order_reply_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_commitments" ADD CONSTRAINT "job_order_commitments_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "job_order_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_commitments" ADD CONSTRAINT "job_order_commitments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "job_order_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_commitments" ADD CONSTRAINT "job_order_commitments_job_order_id_fkey" FOREIGN KEY ("job_order_id") REFERENCES "job_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_commitments" ADD CONSTRAINT "job_order_commitments_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

