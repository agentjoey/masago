CREATE TABLE "tts_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" text NOT NULL,
	"text" text NOT NULL,
	"voice_id" text NOT NULL,
	"model" text NOT NULL,
	"telegram_file_id" text NOT NULL,
	"use_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tts_cache_cache_key_unique" UNIQUE("cache_key")
);
--> statement-breakpoint
CREATE INDEX "tts_cache_last_used_at_idx" ON "tts_cache" USING btree ("last_used_at");