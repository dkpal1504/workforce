-- Documents on a conversation message (multiple per message).
-- ADDITIVE: one new table with its indexes and foreign keys. The bytes are on disk, not here.

-- CreateTable
CREATE TABLE "job_order_message_attachments" (
    "id" SERIAL NOT NULL,
    "thread_id" INTEGER NOT NULL,
    "message_id" INTEGER,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_order_message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_order_message_attachments_storage_key_key" ON "job_order_message_attachments"("storage_key");

-- CreateIndex
CREATE INDEX "job_order_message_attachments_message_id_idx" ON "job_order_message_attachments"("message_id");

-- CreateIndex
CREATE INDEX "job_order_message_attachments_thread_id_idx" ON "job_order_message_attachments"("thread_id");

-- AddForeignKey
ALTER TABLE "job_order_message_attachments" ADD CONSTRAINT "job_order_message_attachments_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "job_order_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_message_attachments" ADD CONSTRAINT "job_order_message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "job_order_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_order_message_attachments" ADD CONSTRAINT "job_order_message_attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

