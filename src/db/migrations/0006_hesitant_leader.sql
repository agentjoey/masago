CREATE TYPE "public"."issue_source" AS ENUM('LLM', 'RULE');--> statement-breakpoint
ALTER TABLE "detected_issues" ADD COLUMN "source" "issue_source" DEFAULT 'LLM' NOT NULL;