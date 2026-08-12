CREATE TYPE "public"."importance" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."knowledge_type" AS ENUM('VOCABULARY', 'GRAMMAR', 'EXPRESSION', 'ERROR_PATTERN');--> statement-breakpoint
CREATE TYPE "public"."learning_event_type" AS ENUM('INTRODUCED', 'REVIEWED', 'USER_ERROR', 'USER_CORRECT', 'RETRY_SUCCEEDED', 'FAILED_RECALL', 'USED_WITH_HINT', 'USED_SPONTANEOUSLY', 'MASTERED');--> statement-breakpoint
CREATE TYPE "public"."plan_item_type" AS ENUM('REVIEW', 'NEW', 'CHALLENGE');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('DRAFT', 'ACTIVE', 'COMPLETED', 'ABANDONED');--> statement-breakpoint
CREATE TYPE "public"."retry_status" AS ENUM('NONE', 'REQUESTED', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('NEW', 'LEARNING', 'REVIEW', 'MASTERED');--> statement-breakpoint
CREATE TYPE "public"."session_mode" AS ENUM('CONVERSATION', 'COACH', 'CHALLENGE');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('ACTIVE', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."turn_input_type" AS ENUM('TEXT', 'VOICE');--> statement-breakpoint
CREATE TYPE "public"."turn_status" AS ENUM('RECEIVED', 'AUDIO_READY', 'AUDIO_NORMALIZED', 'STT_DONE', 'LLM_DONE', 'PERSISTED', 'TEXT_SENT', 'VOICE_SENT', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."update_status" AS ENUM('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');--> statement-breakpoint
CREATE TABLE "learner_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"levels" jsonb,
	"goals" jsonb,
	"preferences" jsonb,
	"profile_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learner_profiles_telegram_user_id_unique" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
CREATE TABLE "detected_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"knowledge_item_id" uuid,
	"knowledge_key" text NOT NULL,
	"original" text NOT NULL,
	"recommended" text NOT NULL,
	"reason" text,
	"natural_alternative" text,
	"importance" "importance" DEFAULT 'MEDIUM' NOT NULL,
	"surfaced_at" timestamp with time zone,
	"retry_status" "retry_status" DEFAULT 'NONE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"mode" "session_mode" NOT NULL,
	"topic" text,
	"status" "session_status" DEFAULT 'ACTIVE' NOT NULL,
	"summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"input_type" "turn_input_type" NOT NULL,
	"status" "turn_status" DEFAULT 'RECEIVED' NOT NULL,
	"raw_transcript" text,
	"normalized_transcript" text,
	"reply_text" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turns_telegram_message_id_unique" UNIQUE("telegram_message_id")
);
--> statement-breakpoint
CREATE TABLE "daily_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"type" "plan_item_type" NOT NULL,
	"knowledge_item_id" uuid,
	"target_count" integer DEFAULT 1 NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"plan_date" date NOT NULL,
	"goal" text,
	"status" "plan_status" DEFAULT 'DRAFT' NOT NULL,
	"source_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "knowledge_type" NOT NULL,
	"key" text NOT NULL,
	"canonical_form" text,
	"metadata" jsonb,
	"mastery" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"turn_id" uuid,
	"knowledge_item_id" uuid,
	"event_type" "learning_event_type" NOT NULL,
	"evidence" jsonb,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "review_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"knowledge_item_id" uuid NOT NULL,
	"next_review_at" timestamp with time zone NOT NULL,
	"interval_days" integer DEFAULT 1 NOT NULL,
	"priority" double precision DEFAULT 0 NOT NULL,
	"state" "review_state" DEFAULT 'NEW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"payload" jsonb,
	"status" "job_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_jobs_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"update_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "update_status" DEFAULT 'RECEIVED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_updates_update_id_unique" UNIQUE("update_id")
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"audio_input_seconds" numeric,
	"audio_output_seconds" numeric,
	"tts_characters" integer,
	"provider_reported_units" jsonb,
	"estimated_cost" numeric,
	"currency" text DEFAULT 'USD' NOT NULL,
	"pricing_version" text NOT NULL,
	"latency_ms" integer,
	"success" boolean DEFAULT true NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "detected_issues" ADD CONSTRAINT "detected_issues_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_issues" ADD CONSTRAINT "detected_issues_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_issues" ADD CONSTRAINT "detected_issues_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_learner_id_learner_profiles_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learner_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_plan_id_daily_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."daily_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plans" ADD CONSTRAINT "daily_plans_learner_id_learner_profiles_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learner_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_learner_id_learner_profiles_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learner_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_learner_id_learner_profiles_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learner_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "detected_issues_turn_key_original_unique" ON "detected_issues" USING btree ("turn_id","knowledge_key","original");--> statement-breakpoint
CREATE INDEX "detected_issues_surfaced_at_idx" ON "detected_issues" USING btree ("surfaced_at") WHERE "detected_issues"."surfaced_at" is null;--> statement-breakpoint
CREATE INDEX "turns_session_id_idx" ON "turns" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_plans_learner_date_unique" ON "daily_plans" USING btree ("learner_id","plan_date");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_items_type_key_unique" ON "knowledge_items" USING btree ("type","key");--> statement-breakpoint
CREATE INDEX "learning_events_knowledge_item_id_idx" ON "learning_events" USING btree ("knowledge_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_queue_learner_item_unique" ON "review_queue" USING btree ("learner_id","knowledge_item_id");--> statement-breakpoint
CREATE INDEX "review_queue_next_review_at_idx" ON "review_queue" USING btree ("next_review_at");--> statement-breakpoint
CREATE INDEX "outbox_jobs_due_at_status_idx" ON "outbox_jobs" USING btree ("due_at","status");