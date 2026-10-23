-- 208_moved_notice_off.sql (user, 2026-10-23: WhatsApp is live again — "remove 'GaadiPe is now fully on the
-- web'"). The site's green top bar and the yellow hanging sign said GaadiPe had moved to the web for good.
-- Both off; scripts/wa-button.js web-only turns them back on if WhatsApp is ever disabled again.
INSERT INTO app_settings (key, value) VALUES ('site_notice_on', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('site_moved_notice', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
