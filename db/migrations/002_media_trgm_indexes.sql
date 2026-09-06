-- Media library: the two columns the data-table quick search runs ILIKE on.
-- Partial on active library files for `display_name`, which is the only set the
-- list route ever searches.
CREATE INDEX IF NOT EXISTS idx_files_display_name_trgm
  ON files USING gin (display_name gin_trgm_ops)
  WHERE status = 'active' AND folder_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_folders_name_trgm
  ON folders USING gin (name gin_trgm_ops);
