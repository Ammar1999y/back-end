-- Every `system`-scoped role gets the whole `media` page.
--
-- System roles cannot be edited from the dashboard and the permission checker
-- has no system bypass, so without this row the super-admin is locked out of
-- the page the migration just created. Standard roles get nothing here; an
-- administrator grants them through the permissions page.
--
-- Hand-written rather than part of the drizzle migration: that file adds
-- 'media' to the `page_name` enum, and PostgreSQL refuses to USE a new enum
-- value inside the transaction that added it. Phase 2 of `scripts/migrate.ts`
-- runs after that transaction has committed.
--
-- `gen_random_uuid()` is a v4 id where the application generates v7. No reader
-- validates a `role_permissions.id` as v7 — the row is only ever addressed by
-- `(role_id, page_name)` — and a v7 generator in SQL is not worth carrying for
-- one seed statement.
INSERT INTO role_permissions (id, role_id, page_name, permissions)
SELECT gen_random_uuid(),
       r.id,
       'media',
       '{"view": true, "edit": true, "editOwn": true, "delete": true, "deleteOwn": true, "create": true, "publish": true}'::jsonb
FROM roles r
WHERE r.scope = 'system'
ON CONFLICT (role_id, page_name) DO NOTHING;

-- A live session carries a copy of its role's permissions in `metadata`, and
-- most reads use that copy (`getUserPermissions`), so a grant that lands only in
-- `role_permissions` is invisible to anyone signed in before the migration until
-- they sign in again. The dashboard's own permission edits patch the copy in
-- place (`refreshRoleSessions`); this is the same patch for this grant. Sessions
-- that already carry a `media` entry are left alone, so re-running is a no-op.
UPDATE sessions s
SET metadata = jsonb_set(
      s.metadata,
      '{permissions,media}',
      '{"view": true, "edit": true, "editOwn": true, "delete": true, "deleteOwn": true, "create": true, "publish": true}'::jsonb,
      true
    ),
    updated_at = now()
FROM users u
JOIN roles r ON r.id = u.role_id
WHERE u.id = s.user_id
  AND r.scope = 'system'
  AND s.expires_at > now()
  AND s.metadata ? 'permissions'
  AND NOT (s.metadata -> 'permissions') ? 'media';
