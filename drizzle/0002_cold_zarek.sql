CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `crawls` ADD `crawl_delay_ms` integer;--> statement-breakpoint
ALTER TABLE `crawls` ADD `next_fetch_at` integer;