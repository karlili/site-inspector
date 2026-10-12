CREATE TABLE `crawls` (
	`id` text PRIMARY KEY NOT NULL,
	`root_url` text NOT NULL,
	`hostname` text NOT NULL,
	`max_depth` integer NOT NULL,
	`max_pages` integer NOT NULL,
	`viewports` text NOT NULL,
	`respect_robots` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`page_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `links` (
	`crawl_id` text NOT NULL,
	`from_page_id` text NOT NULL,
	`to_page_id` text NOT NULL,
	FOREIGN KEY (`crawl_id`) REFERENCES `crawls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_unique_idx` ON `links` (`crawl_id`,`from_page_id`,`to_page_id`);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`crawl_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`depth` integer NOT NULL,
	`parent_page_id` text,
	`http_status` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`pos_x` real,
	`pos_y` real,
	FOREIGN KEY (`crawl_id`) REFERENCES `crawls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pages_crawl_url_idx` ON `pages` (`crawl_id`,`url`);--> statement-breakpoint
CREATE INDEX `pages_crawl_idx` ON `pages` (`crawl_id`);--> statement-breakpoint
CREATE TABLE `screenshots` (
	`id` text PRIMARY KEY NOT NULL,
	`crawl_id` text NOT NULL,
	`page_id` text NOT NULL,
	`viewport` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`file_path` text NOT NULL,
	`thumb_path` text NOT NULL,
	FOREIGN KEY (`crawl_id`) REFERENCES `crawls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `screenshots_page_idx` ON `screenshots` (`page_id`);