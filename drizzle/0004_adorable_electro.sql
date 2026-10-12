ALTER TABLE `crawls` ADD `sitemap_urls` text;--> statement-breakpoint
ALTER TABLE `pages` ADD `source` text DEFAULT 'link' NOT NULL;