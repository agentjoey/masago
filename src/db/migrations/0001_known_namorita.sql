DROP INDEX "outbox_jobs_due_at_status_idx";--> statement-breakpoint
CREATE INDEX "outbox_jobs_status_due_at_idx" ON "outbox_jobs" USING btree ("status","due_at");