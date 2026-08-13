ALTER TYPE "public"."review_state" ADD VALUE 'RELEARNING' BEFORE 'MASTERED';--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "stability" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "difficulty" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "elapsed_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "learning_steps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "reps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "lapses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "last_review" timestamp with time zone;