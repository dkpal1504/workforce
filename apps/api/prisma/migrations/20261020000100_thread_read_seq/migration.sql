-- The unread counter for a conversation: unread = thread.message_count - last_read_seq.
-- Additive, with a constant default, so PostgreSQL adds it without rewriting the table.
ALTER TABLE "job_order_thread_participants" ADD COLUMN "last_read_seq" INTEGER NOT NULL DEFAULT 0;
