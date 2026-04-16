# Dashboard Improvement Ideas

## 1. Own Scope in Permissions

Currently permissions are `view | create | edit | delete` per page. Adding `own` scope means:

- **`users:view:own`** — user can only view records they created
- **`projects:edit:own`** — user can only edit their own projects

**Implementation**: Add `scope` field (`all | own`) to each permission. In data-table queries, append `WHERE createdBy = currentUserId` when scope is `own`. Requires a `createdBy` column on every table that supports this feature.

---

## 2. Activity Log UI

The `audit_logs` table exists in the DB but has no endpoint or UI to display it.

- **Activity log page** in the dashboard — shows who changed what and when
- **Filtering** by user, operation type, date range
- **Timeline** per user or per role — view change history
- **`audit:view`** permission to control access

---

## 3. Notifications System

- Notify user when their permissions or role change
- Notify user when their account is deactivated or sessions are terminated
- Notify admins on new user creation or failed login attempts
- Can be real-time via WebSocket or polling

---

## 4. Bulk Actions

Currently all operations target a single item.

- **Activate/deactivate** multiple users at once
- **Bulk delete** with confirmation
- **Export** user data (CSV/Excel)

---

## 5. Authentication & Security Enhancements

- **Two-Factor Authentication (2FA)** — add TOTP (Google Authenticator) as a second layer beyond the current OTP
- **Login History** — page showing user's past sessions with IP, browser, and location
- **Trusted Devices** — user can trust their devices and get alerted on new device logins
- **Password Policy** — stronger password policy controls (minimum complexity, expiration period)

---

## Rejected / Deferred Ideas

- **User Invitations** — not needed now
- **Role Templates** — not needed now
- **Dashboard Analytics** — will be added later when real content features are built
- **Upload Improvements** — not needed now
- **User Groups** — not needed now
