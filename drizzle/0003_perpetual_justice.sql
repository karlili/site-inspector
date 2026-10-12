ALTER TABLE `pages` ADD `outlinks` text;--> statement-breakpoint
ALTER TABLE `pages` ADD `expand_to_depth` integer;--> statement-breakpoint
-- Pages interrupted by Stop or an aborted crawl were stored as failed; mark them resumable.
UPDATE `pages` SET `status` = 'cancelled' WHERE `status` = 'failed' AND `error` IN ('Crawl cancelled', 'Crawl aborted');
