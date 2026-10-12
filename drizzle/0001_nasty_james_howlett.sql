CREATE TABLE `runners` (
	`id` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`pid` integer NOT NULL,
	`concurrency` integer NOT NULL,
	`active_jobs` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `crawls` ADD `robots_txt` text;--> statement-breakpoint
ALTER TABLE `pages` ADD `claimed_by` text;--> statement-breakpoint
ALTER TABLE `pages` ADD `lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `pages` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `pages_queue_idx` ON `pages` (`status`,`crawl_id`,`depth`);--> statement-breakpoint
-- Crawls left active by the old in-process queue restart from scratch as root-page jobs.
DELETE FROM `links` WHERE `crawl_id` IN (SELECT `id` FROM `crawls` WHERE `status` IN ('queued', 'running'));--> statement-breakpoint
DELETE FROM `pages` WHERE `crawl_id` IN (SELECT `id` FROM `crawls` WHERE `status` IN ('queued', 'running'));--> statement-breakpoint
UPDATE `crawls` SET `status` = 'queued', `page_count` = 1 WHERE `status` IN ('queued', 'running');--> statement-breakpoint
INSERT INTO `pages` (`id`, `crawl_id`, `url`, `depth`) SELECT lower(hex(randomblob(16))), `id`, `root_url`, 0 FROM `crawls` WHERE `status` = 'queued';
