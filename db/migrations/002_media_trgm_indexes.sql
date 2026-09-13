-- Media library: the two columns the data-table quick search runs ILIKE on.

-- Superseded by the index below. The predicate carried `folder_id IS NOT NULL`,
-- which the `unfiled` scope's `folder_id IS NULL` contradicts, so that scope
-- could never use it: measured on 200k rows, the unfiled search planned a
-- parallel sequential scan (72.1 ms, 2632 buffers) against 0.3 ms and 17 buffers
-- once the folder predicate was gone. Dropped rather than left beside the new
-- one — it indexes a strict subset of the same rows for the same queries.
DROP INDEX IF EXISTS idx_files_display_name_trgm;

-- Partial on ACTIVE files and nothing more. Every list scope adds its own
-- folder predicate (`= $1`, `IS NOT NULL`, or `IS NULL` for `unfiled`) and each
-- of the three implies this one, so all three can be answered from here.
CREATE INDEX IF NOT EXISTS idx_files_display_name_active_trgm
  ON files USING gin (display_name gin_trgm_ops)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_folders_name_trgm
  ON folders USING gin (name gin_trgm_ops);
