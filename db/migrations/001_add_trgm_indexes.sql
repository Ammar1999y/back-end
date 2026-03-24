-- Enable trigram extension for fast ILIKE '%text%' searches
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Users: name and email search (partial index — only non-deleted rows)
CREATE INDEX IF NOT EXISTS idx_users_name_trgm
  ON users USING gin (name gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_email_trgm
  ON users USING gin (email gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- Roles: role_name and description search
CREATE INDEX IF NOT EXISTS idx_roles_role_name_trgm
  ON roles USING gin (role_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_roles_description_trgm
  ON roles USING gin (description gin_trgm_ops)
  WHERE description IS NOT NULL;
