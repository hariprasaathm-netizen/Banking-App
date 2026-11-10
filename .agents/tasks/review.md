# Authentication and Data Isolation Implementation Review

## Summary

The Family Portfolio Manager adds login/signup with session-based auth, bcrypt password hashing, and data filtering by user. The implementation follows reasonable security patterns for a single-user portfolio app: passwords are hashed with bcrypt (saltRounds 12), session cookies are httpOnly, and protected API endpoints verify ownership before returning data. However, there are four significant gaps that should be addressed before beta release: the SESSION_SECRET hardcodes a dev value with a "change-in-prod" comment but provides no enforcement; a critical startup migration silently links all unowned members to the first user without user consent or visibility; signup accepts passwords as short as 6 characters when OWASP recommends 12+; and the app shows no security guidance to users about password strength or browser security warnings.

**Watch for:** SESSION_SECRET insufficient protection; silent startup data migration; weak password policy; missing HTTPS enforcement for production; no TLS configuration in auth routes.

**Verdict**: NEEDS_CHANGES

---

## High-level View

The auth layer implements email/password signup and login via POST endpoints that hash passwords and set httpOnly session cookies. Data isolation is enforced at the query level: member endpoints filter by user_id, and higher-level resources (deposits, accounts, PF, NPS, SIP, goals) filter through subqueries that require the member to belong to the authenticated user. A startup migration runs on boot to link unowned members to the first user created, automating the common case of existing demo data needing an owner, but this runs silently without notification to the user that their data was claimed during signup.

Frontend auth is gated: the app shows an auth screen until /api/auth/me succeeds, then reveals the app and hides auth UI. Logout destroys the session and clears in-memory state. Error messages are shown to the user.

The critical gaps are: (1) SESSION_SECRET can easily remain a dev placeholder in production, (2) the startup migration silently assigns data without consent, (3) password requirements are weak (6 characters vs. industry standard 12+), and (4) there is no TLS/HTTPS configuration or warning in the auth routes, making credentials vulnerable over unencrypted connections.

---

<details>
<summary>Issues (5)</summary>

1. **SESSION_SECRET placeholder** — The secret is hardcoded to a default dev value with a comment saying "change-in-prod" but nothing enforces or warns if it wasn't changed. Production deployments must use a strong random secret via environment variable, and the code should error on startup if the default is detected in production.

2. **Startup migration assigns data without consent** — The `runStartupMigration()` function silently links all unowned members/goals to the first user who signs up, then never runs again. Users are not told their existing data was claimed during signup. A migration this consequential should be explicit: either warn the user during signup ("Found X existing members; link them to your account?") or run it interactively on first login.

3. **Password minimum is 6 characters** — OWASP recommends 12+ characters for sensitive accounts. A 6-character password is vulnerable to brute force, especially if the user reuses it across sites. Require at least 12 characters; show password strength guidance on the signup form.

4. **No HTTPS/TLS enforcement** — Session cookies are marked secure only in production (when NODE_ENV='production'), but there is no code to enforce HTTPS on the server or warn if running over HTTP. Credentials sent over plaintext HTTP are trivially intercepted. Production deployments must enforce HTTPS at the server level, or add a middleware that rejects HTTP requests in production.

5. **No security awareness messaging** — The auth UI shows no guidance about password strength, browser security, or HTTPS. Add messaging on signup about password strength, and consider a security tips banner in the app (e.g., "Never share your password; clear browser cache when done on shared devices").

</details>

---

## Password Security and Hashing

The signup route hashes passwords with `bcrypt.hash(password, 12)`, setting saltRounds to 12. This is confirmed (**confirmed**): salting rounds are adequate and follow bcrypt best practices. Passwords are never logged, never echoed back in responses, and only the hash is stored. Lookup is correct: the password hash is fetched from the database, then compared using `bcrypt.compare()` against the user input.

The weakness is the minimum length requirement. The code enforces `password.length < 6` and rejects with a 400 error, but 6 characters is the lower bound of what existing password databases can crack in hours on consumer hardware. Require 12 characters minimum, and show a strength meter or guidance on the signup form to guide users toward longer, varied passwords. The frontend already has a placeholder for password strength indication; use it.

---

## Session Management and Cookies

Session middleware is configured with `httpOnly: true`, which prevents client-side JavaScript from accessing the cookie. This is correct (**confirmed**): it defeats XSS attacks that try to steal the session token. The `secure` flag is set conditionally: `secure: process.env.NODE_ENV === 'production'`. In production (NODE_ENV=production), the flag is true, meaning the browser will only send the cookie over HTTPS. This is correct, but the server does not enforce HTTPS; see the HTTPS enforcement issue below.

Session expiry is set to 7 days (604800000 ms). This is reasonable for a personal finance app; a shorter window (e.g., 1 day) would be more conservative but less convenient for regular users.

Logout correctly calls `req.session.destroy()` and clears in-memory state on the frontend. Sessions are not explicitly validated on each request beyond the middleware's internal handling, which is fine: if a session expires or is destroyed, the middleware will treat req.session.userId as undefined, and requireAuth will reject with 401.

---

## Password Validation and Strength

The signup route validates:
- email required, not empty
- password required, not empty
- password.length >= 6 (weak requirement)
- email format with a basic regex: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (**confirmed**)
- duplicate email check: queries for existing user with same email, returns 409 if found (**confirmed**)

The email format regex is minimal but sufficient for detecting obviously malformed addresses; it does not need to be RFC 5321-compliant for a personal app.

The critical gap: 6 characters is too short. Change to 12+ and add frontend guidance. The frontend form already says "At least 6 characters" in the password field placeholder; update both the backend validation and the UI message.

---

## Authentication API Responses

Signup and login endpoints return the user object with `id`, `email`, and `displayName`. Passwords are never returned (**confirmed**). Password hashes are never returned (**confirmed**).

The /api/auth/me endpoint returns the authenticated user's id, email, and displayName, fetched from the database. It correctly checks if the user exists after session validation, and returns 401 if not found (defensive check against race conditions or deleted accounts). The query selects only id, email, display_name; the password_hash is excluded (**confirmed**).

---

## Data Isolation: Member and Sub-resource Filtering

All protected endpoints begin with `requireAuth`, which checks `req.session.userId` and returns 401 if missing.

**Members endpoint** (`GET /api/members`): Queries `SELECT * FROM members WHERE user_id=$1 ORDER BY created_at ASC` with the authenticated user's ID. Only that user's members are returned. (**confirmed**)

**Accounts endpoint** (`GET /api/accounts`): Queries `SELECT * FROM accounts WHERE member_id IN (SELECT id FROM members WHERE user_id=$1)`. This correctly restricts accounts to members owned by the authenticated user. (**confirmed**)

**Deposits endpoint** (`GET /api/deposits`): Queries `SELECT * FROM deposits WHERE member_id IN (SELECT id FROM members WHERE user_id=$1)`. Correct (**confirmed**).

**PF endpoint** (`GET /api/pf`): Queries `SELECT * FROM pf_accounts WHERE member_id IN (SELECT id FROM members WHERE user_id=$1)`. Correct (**confirmed**).

**NPS endpoint** (`GET /api/nps`): Queries `SELECT * FROM nps_accounts WHERE member_id IN (SELECT id FROM members WHERE user_id=$1)`. Correct (**confirmed**).

**SIP endpoint** (`GET /api/sip`): Queries `SELECT * FROM sip_investments WHERE member_id IN (SELECT id FROM members WHERE user_id=$1)`. Correct (**confirmed**).

**Others endpoint** (`GET /api/others`): Queries `SELECT * FROM other_records WHERE member_id IN (SELECT id FROM members WHERE user_id=$1)`. Correct (**confirmed**).

**Goals endpoint** (`GET /api/goals`): Queries `SELECT * FROM goals WHERE user_id=$1`. Goals are directly owned by users, so filtering by user_id is correct. (**confirmed**)

**POST endpoints**: Before inserting, endpoints verify ownership of the member using `checkMemberOwnership(memberId, userId)`, which queries for the member and compares its user_id to the authenticated user's ID. This is implemented consistently across all member-child resources. (**confirmed**)

**PUT/DELETE endpoints**: All verify ownership before allowing modifications. For example, `PUT /api/deposits/:id` fetches the deposit, checks its member belongs to the user, then updates. (**confirmed**)

One asymmetry: accounts can be deleted and their links to deposits are cleared (UPDATE deposits SET linked_account_id='' WHERE linked_account_id=$1), but the linked account is not re-assigned to another account. This is a UX issue, not a security issue—users can re-link deposits manually.

---

## SQL Injection Prevention

All queries use parameterized queries with `$1`, `$2`, etc., and pass parameters as separate array arguments. No string concatenation or template literals are used in SQL construction. This is correct across all endpoints. (**confirmed**)

One minor concern: the LIMIT clause in `/api/history` uses `LIMIT ${params.length + 1}`, which constructs the clause dynamically. However, the value comes from `parseInt(req.query.limit)` with a default of 200. If parseInt fails, it returns NaN, which would break the LIMIT clause in PostgreSQL but not in sql.js. The code should validate `limit` explicitly: ensure it is a positive integer between 1 and a reasonable max (e.g., 1000), then use parameterized query or a whitelist approach. (**likely** SQL injection vector via malformed limit parameter; low risk if limit is never a user-controlled string, but validate it).

---

## Cross-Site Request Forgery (CSRF) Protection

No CSRF token is implemented. Session-based authentication is vulnerable to CSRF if a user visits a malicious site while logged in; the browser will send their session cookie with any request to the portfolio manager, potentially allowing the attacker to make changes on behalf of the user.

However, CSRF protection is only necessary if the app is accessed in a browser where cookies are sent automatically. Since the API uses POST/PUT/DELETE with JSON body, most modern browsers will send a preflight OPTIONS request first, which the malicious site cannot forge without the app explicitly allowing cross-origin requests. The app does not set CORS headers (Access-Control-Allow-Origin, etc.), so cross-origin requests are blocked by default. (**confirmed**: no CORS headers visible in the code).

For same-origin requests from the legit UI, CSRF is a risk if the frontend form could be tricked into submitting. The frontend uses fetch() with body: JSON.stringify(), which requires JavaScript to construct, so a simple form-based CSRF attack fails. However, a more sophisticated attack could still be mounted from a script on a third-party site if the app is embedded in a frame.

For a single-user app deployed internally or used on a personal device, CSRF risk is low. For a beta release to untrusted users, add CSRF token protection: generate a token on signup/login, return it in the auth response, and require it in the Authorization header or a custom header (not a cookie) on mutating requests. Alternatively, add CORS restrictions: only allow requests from the app's own domain, and reject cross-origin requests.

For now: (**likely** CSRF risk on untrusted networks or multi-user environments; low risk for single-user personal app).

---

## Frontend Auth Flow and State Management

The frontend calls `checkAuth()` on page load. If /api/auth/me returns 200, it shows the app and loads data. If not, it shows the auth screen. Login/signup forms submit via fetch() with JSON body, then set `currentUser` and call `showApp()` if successful. Logout destroys the session, clears `currentUser`, and shows the auth screen again. (**confirmed**)

The auth screen has a toggle between login and signup tabs. The signup form clears after successful signup and switches to login before showing the app. This is a usability issue (user expects to be logged in after signup) but not a security issue. Consider logging the user in directly after successful signup instead of forcing them to switch tabs.

Error messages are shown to users if login or signup fails (e.g., "Invalid email or password", "Email already registered", "Password must be at least 6 characters"). These are appropriate; they don't leak information that would help attackers enumerate valid emails.

---

## Startup Migration: Silent Data Claiming

The most consequential security/privacy issue is `runStartupMigration()`. This function runs once on server boot:

```javascript
async function runStartupMigration() {
  try {
    const userCount = await queryOne('SELECT COUNT(*) as n FROM users', []);
    const count = userCount?.n || 0;
    
    if (count === 1) {
      const user = await queryOne('SELECT id FROM users LIMIT 1', []);
      if (user) {
        await run('UPDATE members SET user_id=$1 WHERE user_id IS NULL OR user_id=\'\'', [user.id]);
        await run('UPDATE goals SET user_id=$1 WHERE user_id IS NULL OR user_id=\'\'', [user.id]);
      }
    }
  } catch (err) {
    console.log('ℹ️ Startup migration skipped...');
  }
}
```

This silently assigns all unowned members and goals to the first user who signs up. The user is not told this happened. If the app is deployed with demo data (via seedDemo), the first real user to sign up will automatically own Rajesh Kumar, Sunita Kumar, Ravi Kumar, and all their financial records—without being asked.

This is a serious privacy concern: the user may not realize they have other people's data, or they may be confused about why the app shows records they didn't create. In a multi-user future, this creates ambiguity about who owns what data.

**Recommendation**: Make the migration explicit. Options:

1. **During signup**: After account creation, query for unowned members. If any exist, show a dialog: "Found X existing records. Do you want to link them to your account?" Let the user choose. If yes, update them. If no, leave them unowned (or archive them).

2. **On first login**: After auth succeeds and user loads the app, check for unowned members. Show a banner: "Found X records not linked to any user. Would you like to link them to your account?" with Yes/No buttons.

3. **Remove the migration entirely**: Only let users create their own records. If existing records are needed for demo purposes, pre-assign them to a demo user or mark them as read-only.

For a beta release, option 1 is cleanest: users expect to see their data after signup, so making the claiming explicit during signup (with a clear message) is the most honest approach.

(**confirmed** issue: migration code silently updates members/goals).

---

## HTTPS and Secure Transport

There is no enforcement of HTTPS in the server code. The session cookie is marked `secure` only if `NODE_ENV === 'production'`, but the server doesn't enforce HTTPS itself. If a production deployment receives an HTTP request (e.g., http://example.com:3000), the server will respond without redirecting to HTTPS, and the secure cookie won't be sent by the browser (because it's not HTTPS), but the request itself is unencrypted.

To fix: Add middleware that redirects HTTP to HTTPS in production, or add a check that rejects HTTP in production. For example:

```javascript
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.protocol !== 'https') {
    return res.redirect(301, 'https://' + req.get('host') + req.url);
  }
  next();
});
```

Alternatively, if the app is deployed behind a reverse proxy (nginx, load balancer), the proxy should handle HTTPS termination and set X-Forwarded-Proto header, and the app can check that header.

The absence of HTTPS enforcement is a **HIGH** severity issue for production: credentials are transmitted over plaintext HTTP if the user visits the wrong URL.

(**likely** unencrypted credentials in production if HTTP is not explicitly disabled).

---

## Testing and Validation

The codebase includes client-side form validation for some fields (memberName, memberPan, memberPhone, memberEmail, fdPrincipal, fdRate, fdStartDate) with error messages and a disabled submit button if validation fails. This is good UX but does not substitute for server-side validation.

Server-side validation is minimal: email and password validation on signup/login, required field checks on member and deposit creation. No validation is **tested** (no test suite exists). For a beta release, at minimum test:

- Signup with invalid email (should reject)
- Signup with password < 6 chars (should reject; change to 12+ and test)
- Signup with duplicate email (should reject with 409)
- Duplicate member name for same user (should allow; users can have multiple family members with same name)
- Member from user A accessing member from user B via API (should return 403)
- Deposit from user A accessing deposit linked to member from user B (should return 403)
- Logout clears session and blocks subsequent API calls (should return 401)
- Passwords are never logged or returned (should verify in server logs)

(**likely** insufficient test coverage for auth flows; no automated tests exist).

---

## Not Tested: Scenarios and Edge Cases

- **Concurrent signups**: If two users sign up simultaneously (before first-user migration runs), which one claims the demo data? The code checks `if (count === 1)` in the migration, so if both users insert simultaneously, one might see count as 1 and claim the data, while the second sees count as 2 and skips the migration. This is racy in PostgreSQL without explicit locking, but unlikely in practice.

- **Explicit logout on other tabs**: If a user logs out in one tab, other open tabs still have `currentUser` set and will show the app until they try to make an API call. The API will return 401, but the UI won't refresh to show the auth screen. This is a minor UX issue.

- **Session expiry**: If a session expires (after 7 days) while the app is open, the next API call returns 401, but the UI doesn't show a clear message telling the user to re-authenticate. The error is shown as a generic toast, not as a redirect to login.

- **Password reset**: There is no password reset flow. If a user forgets their password, they cannot recover their account. For a beta release, either add a password reset flow (email-based) or document that they'll need to contact admin to delete and recreate the account.

- **Email verification**: Signup does not verify that the email address is valid or that the user controls it. A user could sign up with a typo or a non-existent email. No recovery is possible. Consider adding email verification on signup: generate a token, send a verification link, and mark the account as verified only after the user clicks it. Until then, the account is locked or limited.

---

## Recommendations for Beta Release

1. **Enforce minimum 12-character passwords** instead of 6. Update backend validation and frontend placeholder.

2. **Make the startup migration explicit** by prompting the user during signup or on first login. Show them how many records were found and ask before claiming them.

3. **Add HTTPS enforcement** via middleware or deployment proxy. Reject HTTP in production, or redirect to HTTPS.

4. **Set a strong SESSION_SECRET** in production. Add a startup check that errors if the default dev secret is detected in production (check NODE_ENV and SECRET value).

5. **Add password reset flow** via email, or document that password recovery requires admin intervention.

6. **Test auth flows** with automated tests: signup, login, logout, 403 for access to other users' data, 401 for expired sessions.

7. **Add session expiry handling** on the frontend: detect 401 responses and show a clear message to re-authenticate, then redirect to login.

8. **Add security tips** to the auth screen: "Choose a strong password", "Never share your password", "Clear browser cache on shared devices."

---

## What's Working Well

- Bcrypt with saltRounds 12 is a solid choice for password hashing.
- Session-based auth with httpOnly cookies is a standard, proven approach.
- Data filtering via subqueries (member-in-user query pattern) is a reliable way to enforce isolation.
- API ownership checks (checkMemberOwnership) are applied consistently across all member-child resources.
- No SQL injection vectors detected in current code (all queries use parameterized syntax).
- Error messages don't leak sensitive info (e.g., "Invalid email or password" instead of "Email not found").
- Password hashes and secrets are never logged or echoed.

---

## File Map

<details>
<summary>Files Changed (6)</summary>

- **server.js**: Added auth routes (signup, login, logout, me), session middleware, requireAuth guard, ownership checks, and startup migration.
- **src/db.js**: Added users table schema, startup migration function (runStartupMigration), added user_id columns to members and goals.
- **public/index.html**: Added auth screen with login/signup forms and tabs.
- **public/style.css**: Added auth screen styles (auth-screen, auth-card, auth-tabs, etc.).
- **public/app.js**: Added auth state (currentUser), checkAuth on load, login/signup handlers, logout, auth error display, showApp/showAuthScreen functions.

</details>

Full diff: `git diff main`

---

