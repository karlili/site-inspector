CREATE TABLE "crawls" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "crawls_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text,
	"root_url" text NOT NULL,
	"hostname" text NOT NULL,
	"max_depth" integer NOT NULL,
	"max_pages" integer NOT NULL,
	"viewports" jsonb NOT NULL,
	"respect_robots" boolean NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"page_count" integer DEFAULT 0 NOT NULL,
	"robots_txt" text,
	"crawl_delay_ms" integer,
	"sitemap_urls" jsonb,
	"next_fetch_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "links" (
	"crawl_id" text NOT NULL,
	"from_page_id" text NOT NULL,
	"to_page_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "pages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"crawl_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"depth" integer NOT NULL,
	"parent_page_id" text,
	"http_status" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"redirect_url" text,
	"pos_x" double precision,
	"pos_y" double precision,
	"claimed_by" text,
	"lease_expires_at" timestamp (3) with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"outlinks" jsonb,
	"expand_to_depth" integer,
	"source" text DEFAULT 'link' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"pid" integer NOT NULL,
	"concurrency" integer NOT NULL,
	"active_jobs" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screenshots" (
	"id" text PRIMARY KEY NOT NULL,
	"crawl_id" text NOT NULL,
	"page_id" text NOT NULL,
	"viewport" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"file_path" text NOT NULL,
	"thumb_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_crawl_id_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "links_unique_idx" ON "links" USING btree ("crawl_id","from_page_id","to_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_crawl_url_idx" ON "pages" USING btree ("crawl_id","url");--> statement-breakpoint
CREATE INDEX "pages_crawl_idx" ON "pages" USING btree ("crawl_id");--> statement-breakpoint
CREATE INDEX "pages_queue_idx" ON "pages" USING btree ("status","crawl_id","depth");--> statement-breakpoint
CREATE INDEX "pages_parent_idx" ON "pages" USING btree ("parent_page_id");--> statement-breakpoint
CREATE INDEX "screenshots_page_idx" ON "screenshots" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "screenshots_crawl_idx" ON "screenshots" USING btree ("crawl_id");