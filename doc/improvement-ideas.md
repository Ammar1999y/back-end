# Dashboard Improvement Ideas

## 1. Own / Self Scope in Permissions

Currently permissions are `view | create | edit | delete` per page. Adding scope support means:

- **`users:view:self`** — user can only view their own account
- **`users:edit:self`** — user can only edit their own account
- **`projects:view:own`** — user can only view records they created
- **`projects:edit:own`** — user can only edit their own records

**Implementation**: Add a scope layer such as `all | own | self` to each permission action. In data-table queries, append `WHERE createdBy = currentUserId` when scope is `own`. For account-specific actions, compare against the current logged-in user when scope is `self`.

---

## 2. Activity Log UI

The `audit_logs` table exists in the DB but has no endpoint or UI to display it.

- **Activity log page** in the dashboard — shows who changed what and when
- **Filtering** by user, table, action type, API path, and date range
- **Details drawer** — view `oldData`, `newData`, and `changedFields`
- **Timeline** per user or per role — view change history
- **`audit:view`** permission to control access

---

## 3. Authentication & Security Enhancements

- **Two-Factor Authentication (2FA)** — add TOTP (Google Authenticator) as a second layer beyond the current OTP
- **Login History** — page showing user's past sessions with IP, browser, and location
- **Trusted Devices** — user can trust their devices and get alerted on new device logins
