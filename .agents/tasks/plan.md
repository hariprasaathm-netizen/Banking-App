# Implementation Plan: User Authentication (Login/Signup)

## Overview
Add user authentication to the Family Portfolio Manager app. Users will create accounts (signup), log in with email/password, and then access their own family data. Existing members (Prasath Murugesan, KeshavShree, AbinayaPradha R) will be automatically linked to the first registered user at startup.

## Design Decisions

### 1. Session Management Strategy
**Decision**: Use `express-session` with in-memory store for development, configurable to external store for production.
**Rationale**: Simple, no additional dependencies required for basic flow. The user can migrate to Redis/MongoDB store if scaling. Session-based auth is simpler than JWT for a traditional server-rendered app, and the frontend is already using fetch-based API calls which will include cookies automatically.

### 2. Password Hashing
**Decision**: Use `bcryptjs` with saltRounds=12.
**Rationale**: Pure JavaScript implementation (no native bindings), works cross-platform on Windows, and standard OWASP-compliant rounds.

### 3. Data Linkage Strategy
**Decision**: Add `user_id TEXT DEFAULT ''` column to members table. At startup, run an idempotent migration that links existing members (where user_id IS NULL or = '') to the first registered user via a special admin flag in the users table.
**Rationale**: Preserves all existing data without deletion, migration is one-time and safe to re-run. Avoids querying for "first user" from multiple processes if server restarts.

### 4. Scope of Auth Requirement
**Decision**: ALL existing `/api/*` routes except `/api/auth/*` will require authentication. Data filtering happens at the query level (WHERE user_id = $1) so each user only sees their own family.
**Rationale**: Ensures multi-tenancy at the database layer, not just the API layer. Prevents accidental data leaks from missing middleware on a route.

### 5. seedDemo() Guard
**Decision**: `seedDemo()` will only run if NOT using PostgreSQL (i.e., isPostgres === false).
**Rationale**: Demo data is for local SQLite development only. In production on PostgreSQL, we don't want to clobber real data. Existing production users' data is preserved by the migration.

## Implementation Steps

### Phase 1: Database Schema (1 item)

- [ ] **1. Add users table and user_id column to members table**
      
      In `src/db.js`, add the users table schema to SCHEMA constant before the closing backtick:
      ```sql
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT DEFAULT '',
        is_admin INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ```
      
      Add user_id column to members table (also in SCHEMA, using ALTER TABLE for PostgreSQL compatibility):
      ```sql
      ALTER TABLE IF EXISTS members ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT '';
      ```
      
      Files: `src/db.js` (SCHEMA constant)
      
      Verify: 
      ```bash
      npm start
      # Confirm server starts without errors
      # Check PostgreSQL (if using): psql -U postgres -d railway -c "\d users" should show the table
      # Check SQLite (if local): sqlite3 portfolio.db ".schema users" should show the table
      ```

### Phase 2: Dependencies (1 item)

- [ ] **2. Install bcryptjs and express-session**
      
      Add to `package.json` dependencies:
      - `bcryptjs@2.4.3`
      - `express-session@1.17.3`
      
      Then run `npm install`.
      
      Files: `package.json`
      
      Verify: 
      ```bash
      npm install
      npm ls bcryptjs express-session
      # Confirm both packages listed with correct versions
      ```

### Phase 3: Session Middleware (1 item)

- [ ] **3. Add session middleware to server.js**
      
      At the top of `server.js` (after `require('dotenv').config()` and before app setup), add:
      ```javascript
      const session = require('express-session');
      ```
      
      After `app.use(express.json())`, before `app.use(express.static(...))`, add:
      ```javascript
      app.use(session({
        secret: process.env.SESSION_SECRET || 'fd-portfolio-dev-secret-change-in-prod',
        resave: false,
        saveUninitialized: false,
        cookie: { 
          httpOnly: true, 
          secure: process.env.NODE_ENV === 'production',
          maxAge: 1000 * 60 * 60 * 24 * 7  // 7 days
        }
      }));
      ```
      
      Files: `server.js`
      
      Verify:
      ```bash
      npm start
      # Server should start without errors
      # No new functionality yet, but session middleware is active
      ```

### Phase 4: Auth Middleware and Routes (1 item)

- [ ] **4. Add requireAuth middleware and auth routes (/api/auth/*)**
      
      In `server.js`, after importing session but before any API routes (after the row converter functions), add:
      
      ```javascript
      const bcrypt = require('bcryptjs');
      
      // ── Auth Middleware ───────────────────────────────────────
      async function requireAuth(req, res, next) {
        if (!req.session.userId) {
          return res.status(401).json({ error: 'Not authenticated' });
        }
        next();
      }
      
      // Email validation helper
      function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      }
      
      // ── Auth Routes ──────────────────────────────────────────
      app.post('/api/auth/signup', async (req, res) => {
        try {
          const { email, password, displayName = '' } = req.body;
          
          // Validate input
          if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
          }
          if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
          }
          if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
          }
          
          // Check if user already exists
          const existingUser = await queryOne('SELECT id FROM users WHERE email=$1', [email]);
          if (existingUser) {
            return res.status(409).json({ error: 'Email already registered' });
          }
          
          // Hash password
          const passwordHash = await bcrypt.hash(password, 12);
          
          // Create user
          const userId = uid();
          const isFirstUser = (await queryOne('SELECT COUNT(*) as n FROM users')?.n || 0) === 0;
          await run(
            'INSERT INTO users (id, email, password_hash, display_name, is_admin) VALUES ($1,$2,$3,$4,$5)',
            [userId, email, passwordHash, displayName, isFirstUser ? 1 : 0]
          );
          
          // If first user, link existing members to this user
          if (isFirstUser) {
            await run('UPDATE members SET user_id=$1 WHERE user_id IS NULL OR user_id=\'\'', [userId]);
          }
          
          // Set session
          req.session.userId = userId;
          
          res.status(201).json({
            id: userId,
            email: email,
            displayName: displayName
          });
        } catch (err) {
          console.error('Signup error:', err);
          res.status(500).json({ error: err.message });
        }
      });
      
      app.post('/api/auth/login', async (req, res) => {
        try {
          const { email, password } = req.body;
          
          if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
          }
          
          // Find user by email
          const user = await queryOne('SELECT id, email, password_hash, display_name FROM users WHERE email=$1', [email]);
          if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
          }
          
          // Compare password
          const isMatch = await bcrypt.compare(password, user.password_hash);
          if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email or password' });
          }
          
          // Set session
          req.session.userId = user.id;
          
          res.json({
            id: user.id,
            email: user.email,
            displayName: user.display_name
          });
        } catch (err) {
          console.error('Login error:', err);
          res.status(500).json({ error: err.message });
        }
      });
      
      app.post('/api/auth/logout', (req, res) => {
        req.session.destroy((err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ ok: true });
        });
      });
      
      app.get('/api/auth/me', async (req, res) => {
        if (!req.session.userId) {
          return res.status(401).json({ error: 'Not authenticated' });
        }
        try {
          const user = await queryOne('SELECT id, email, display_name FROM users WHERE id=$1', [req.session.userId]);
          if (!user) {
            req.session.destroy();
            return res.status(401).json({ error: 'User not found' });
          }
          res.json({
            id: user.id,
            email: user.email,
            displayName: user.display_name
          });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });
      ```
      
      Files: `server.js`
      
      Verify:
      ```bash
      npm start
      # Open Postman or curl and test:
      curl -X POST http://localhost:3000/api/auth/signup \
        -H "Content-Type: application/json" \
        -d '{"email":"test@example.com","password":"password123","displayName":"Test User"}'
      # Should return {id, email, displayName}
      
      curl -X GET http://localhost:3000/api/auth/me
      # Should return the user (session cookie included)
      ```

### Phase 5: Apply Auth Middleware to Existing Routes (1 item)

- [ ] **5. Add requireAuth to all existing /api/* routes (except /api/auth/*) and filter by user_id**
      
      Replace the `app.get('/api/members', ...)` route and every other data route with requireAuth middleware.
      
      **For GET routes**, add requireAuth and filter by user_id:
      - `/api/members` → filter: `WHERE user_id = $1`
      - `/api/accounts` → filter via member relationship: `WHERE member_id IN (SELECT id FROM members WHERE user_id = $1)`
      - `/api/deposits` → filter via member: `WHERE member_id IN (SELECT id FROM members WHERE user_id = $1)`
      - `/api/pf` → filter via member: `WHERE member_id IN (SELECT id FROM members WHERE user_id = $1)`
      - `/api/nps` → filter via member: `WHERE member_id IN (SELECT id FROM members WHERE user_id = $1)`
      - `/api/sip` → filter via member: `WHERE member_id IN (SELECT id FROM members WHERE user_id = $1)`
      - `/api/others` → filter via member: `WHERE member_id IN (SELECT id FROM members WHERE user_id = $1)`
      - `/api/goals` → no user_id column, so return all (global) OR add user_id column; decision: add user_id to goals table (ALTER TABLE goals ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT '')
      - `/api/history` → filter: `WHERE changed_by = $1` (or add user_id, decision: add user_id column)
      
      **For POST routes**, automatically set user_id or member_id:
      - `/api/members` → set `user_id = req.session.userId` when inserting
      - `/api/accounts`, `/api/deposits`, etc. → already have `member_id`; no change needed if member lookup validates ownership
      
      **For PUT/DELETE routes**, add requireAuth and validate ownership before allowing modification.
      
      **Implementation strategy**: Create a helper function to ensure ownership, called in every PUT/DELETE.
      
      ```javascript
      // ── Ownership check helper ───────────────────────────────
      async function checkMemberOwnership(memberId, userId) {
        const m = await queryOne('SELECT user_id FROM members WHERE id=$1', [memberId]);
        return m && m.user_id === userId;
      }
      ```
      
      Example for `/api/members` GET (with filtering):
      ```javascript
      app.get('/api/members', requireAuth, async (req, res) => {
        try {
          const rows = await query('SELECT * FROM members WHERE user_id=$1 ORDER BY created_at ASC', [req.session.userId]);
          res.json(rows.map(rowToMember));
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });
      ```
      
      Example for `/api/members` POST (with user_id assignment):
      ```javascript
      app.post('/api/members', requireAuth, async (req, res) => {
        try {
          const { name, relation, pan='', phone='', email='', notes='' } = req.body;
          if (!name || !relation) return res.status(400).json({ error: 'name and relation are required' });
          const id = uid();
          await run(`INSERT INTO members (id,name,relation,pan,phone,email,notes,user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [id, name, relation, pan, phone, email, notes, req.session.userId]);
          await logAudit('CREATE', 'Member', id, name, `Relation: ${relation}`);
          const row = await queryOne('SELECT * FROM members WHERE id=$1', [id]);
          res.status(201).json(rowToMember(row));
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });
      ```
      
      Example for `/api/members/:id` PUT (with ownership check):
      ```javascript
      app.put('/api/members/:id', requireAuth, async (req, res) => {
        try {
          const isOwner = await checkMemberOwnership(req.params.id, req.session.userId);
          if (!isOwner) return res.status(403).json({ error: 'Access denied' });
          
          const { name, relation, pan='', phone='', email='', notes='' } = req.body;
          await run(`UPDATE members SET name=$1,relation=$2,pan=$3,phone=$4,email=$5,notes=$6 WHERE id=$7`,
              [name, relation, pan, phone, email, notes, req.params.id]);
          const row = await queryOne('SELECT * FROM members WHERE id=$1', [req.params.id]);
          if (!row) return res.status(404).json({ error: 'Member not found' });
          await logAudit('UPDATE', 'Member', req.params.id, name, `Relation: ${relation}`);
          res.json(rowToMember(row));
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });
      ```
      
      **Apply this pattern to all data routes**: members, accounts, deposits, pf, nps, sip, others, goals, history.
      
      For routes that depend on member_id, the ownership check is: verify that the member belongs to the current user before allowing the operation.
      
      Files: `server.js` (all GET, POST, PUT, DELETE routes except /api/auth/*)
      
      Verify:
      ```bash
      npm start
      
      # Test: GET /api/members without session should return 401
      curl -X GET http://localhost:3000/api/members
      # Response: {"error":"Not authenticated"}
      
      # Test: POST /api/auth/login to get session
      curl -X POST http://localhost:3000/api/auth/login \
        -H "Content-Type: application/json" \
        -d '{"email":"test@example.com","password":"password123"}' \
        -c cookies.txt
      
      # Test: GET /api/members with session should return user's members
      curl -X GET http://localhost:3000/api/members -b cookies.txt
      # Response: [list of members for that user]
      ```

### Phase 6: Update seedDemo() Guard (1 item)

- [ ] **6. Guard seedDemo() to only run for SQLite, not PostgreSQL**
      
      In `server.js`, modify the `seedDemo()` function call in `async function start()` to be conditional:
      
      ```javascript
      async function start() {
        try {
          await initDb();
          
          // Only seed demo data if using SQLite (not PostgreSQL)
          const isPostgres = !!process.env.DATABASE_URL;
          if (!isPostgres) {
            await seedDemo();
          }
          
          const PORT = process.env.PORT || 3000;
          app.listen(PORT, () => {
            console.log(`\n🏦 Family Portfolio Manager → http://localhost:${PORT}\n`);
          });
        } catch (err) {
          console.error('❌ Failed to start server:', err);
          process.exit(1);
        }
      }
      ```
      
      Files: `server.js` (start function)
      
      Verify:
      ```bash
      # Test with SQLite (no DATABASE_URL)
      npm start
      # Should seed demo data and show "ℹ️  Existing data found..." on subsequent runs
      
      # Test with PostgreSQL (with DATABASE_URL set)
      DATABASE_URL=postgresql://... npm start
      # Should NOT seed demo data, and should show successful connection
      ```

### Phase 7: Frontend Auth Screen (1 item)

- [ ] **7. Create login/signup UI and add auth check on app load**
      
      In `public/index.html`, add an auth screen section at the top (before the main header and content), right after the body tag:
      
      ```html
      <!-- ===== AUTH SCREEN ===== -->
      <div id="authScreen" class="auth-screen">
        <div class="auth-card">
          <div class="auth-header">
            <span class="auth-icon">🏦</span>
            <h1>Portfolio Manager</h1>
            <p class="auth-subtitle">Manage your family's finances</p>
          </div>
          
          <div class="auth-tabs">
            <button class="auth-tab-btn active" data-tab="login">Login</button>
            <button class="auth-tab-btn" data-tab="signup">Sign Up</button>
          </div>
          
          <!-- Login Tab -->
          <div id="loginTab" class="auth-tab active">
            <form id="loginForm">
              <div class="form-group">
                <label for="loginEmail">Email</label>
                <input type="email" id="loginEmail" name="email" required placeholder="your@email.com" />
              </div>
              <div class="form-group">
                <label for="loginPassword">Password</label>
                <input type="password" id="loginPassword" name="password" required placeholder="••••••••" />
              </div>
              <button type="submit" class="auth-submit-btn">Login</button>
            </form>
          </div>
          
          <!-- Signup Tab -->
          <div id="signupTab" class="auth-tab">
            <form id="signupForm">
              <div class="form-group">
                <label for="signupName">Display Name</label>
                <input type="text" id="signupName" name="displayName" placeholder="Your Name" />
              </div>
              <div class="form-group">
                <label for="signupEmail">Email</label>
                <input type="email" id="signupEmail" name="email" required placeholder="your@email.com" />
              </div>
              <div class="form-group">
                <label for="signupPassword">Password</label>
                <input type="password" id="signupPassword" name="password" required placeholder="At least 6 characters" />
              </div>
              <button type="submit" class="auth-submit-btn">Sign Up</button>
            </form>
          </div>
          
          <div id="authError" class="auth-error hidden"></div>
          <div id="authLoading" class="auth-loading hidden">
            <p>Loading...</p>
          </div>
        </div>
      </div>
      ```
      
      In `public/app.js`, add at the very top (before any other code):
      
      ```javascript
      // ── Auth State & Helpers ──────────────────────────────────
      let currentUser = null;
      
      async function checkAuth() {
        try {
          const res = await fetch('/api/auth/me');
          if (res.ok) {
            currentUser = await res.json();
            showApp();
            return true;
          } else {
            showAuthScreen();
            return false;
          }
        } catch (err) {
          console.error('Auth check failed:', err);
          showAuthScreen();
          return false;
        }
      }
      
      function showAuthScreen() {
        document.getElementById('authScreen').classList.remove('hidden');
        document.querySelector('header.topbar').classList.add('hidden');
        document.querySelector('main.main-content').classList.add('hidden');
      }
      
      function showApp() {
        document.getElementById('authScreen').classList.add('hidden');
        document.querySelector('header.topbar').classList.remove('hidden');
        document.querySelector('main.main-content').classList.remove('hidden');
        
        // Update topbar with user info
        const userDisplay = document.querySelector('.topbar-brand');
        if (userDisplay && currentUser) {
          userDisplay.innerHTML = `<span class="brand-icon">🏦</span><span class="brand-name">${currentUser.displayName || currentUser.email}</span>`;
        }
      }
      
      async function handleLogin(e) {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        showAuthLoading(true);
        clearAuthError();
        
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Login failed');
          }
          
          currentUser = await res.json();
          document.getElementById('loginForm').reset();
          showApp();
          loadAllData();
        } catch (err) {
          showAuthError(err.message);
        } finally {
          showAuthLoading(false);
        }
      }
      
      async function handleSignup(e) {
        e.preventDefault();
        const email = document.getElementById('signupEmail').value;
        const password = document.getElementById('signupPassword').value;
        const displayName = document.getElementById('signupName').value;
        
        showAuthLoading(true);
        clearAuthError();
        
        try {
          const res = await fetch('/api/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, displayName })
          });
          
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Signup failed');
          }
          
          currentUser = await res.json();
          document.getElementById('signupForm').reset();
          switchAuthTab('login');
          showApp();
          loadAllData();
        } catch (err) {
          showAuthError(err.message);
        } finally {
          showAuthLoading(false);
        }
      }
      
      function switchAuthTab(tab) {
        document.querySelectorAll('.auth-tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.auth-tab').forEach(el => el.classList.remove('active'));
        document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
        document.getElementById(`${tab}Tab`).classList.add('active');
      }
      
      function showAuthError(msg) {
        const el = document.getElementById('authError');
        el.textContent = msg;
        el.classList.remove('hidden');
      }
      
      function clearAuthError() {
        document.getElementById('authError').classList.add('hidden');
      }
      
      function showAuthLoading(isLoading) {
        const el = document.getElementById('authLoading');
        if (isLoading) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      }
      
      // ── Setup auth event listeners ─────────────────────────────
      document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
      document.getElementById('signupForm')?.addEventListener('submit', handleSignup);
      document.querySelectorAll('.auth-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchAuthTab(btn.dataset.tab));
      });
      ```
      
      Add logout button to the topbar. In `public/index.html`, in the `<nav class="topbar-nav">` section, add at the end:
      
      ```html
      <button class="nav-btn" id="logoutBtn" data-page="logout">🚪 Logout</button>
      ```
      
      In `public/app.js`, add logout handler after the auth functions:
      
      ```javascript
      async function handleLogout() {
        try {
          await fetch('/api/auth/logout', { method: 'POST' });
          currentUser = null;
          showAuthScreen();
        } catch (err) {
          console.error('Logout failed:', err);
        }
      }
      
      document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
      ```
      
      Finally, call `checkAuth()` on app load. At the end of `public/app.js`, replace or add:
      
      ```javascript
      // ── App Initialization ────────────────────────────────────
      async function initApp() {
        const isAuthenticated = await checkAuth();
        if (isAuthenticated) {
          loadAllData();
        }
      }
      
      // Call on DOM ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initApp);
      } else {
        initApp();
      }
      ```
      
      Files: `public/index.html`, `public/app.js`
      
      Verify:
      ```bash
      npm start
      # Open browser to http://localhost:3000
      # Should show auth screen (login/signup tabs)
      # Sign up with test@example.com / password123
      # Should redirect to main app after signup
      # Verify current user name displays in topbar
      # Click logout button
      # Should return to auth screen
      # Existing members should be visible after login
      ```

### Phase 8: Frontend Styling (1 item)

- [ ] **8. Add CSS for auth screen and components**
      
      In `public/style.css`, add at the top (after existing color/variable definitions, or create new section):
      
      ```css
      /* ---- AUTH SCREEN ---- */
      .auth-screen {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: linear-gradient(135deg, var(--primary) 0%, #667eea 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      
      .auth-screen.hidden {
        display: none;
      }
      
      .auth-card {
        background: white;
        border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        max-width: 400px;
        width: 90%;
        padding: 2rem;
      }
      
      .auth-header {
        text-align: center;
        margin-bottom: 2rem;
      }
      
      .auth-icon {
        font-size: 2.5rem;
        display: block;
        margin-bottom: 0.5rem;
      }
      
      .auth-header h1 {
        font-size: 1.8rem;
        margin: 0.5rem 0;
        color: var(--text-primary);
      }
      
      .auth-subtitle {
        color: var(--gray-500);
        margin: 0.5rem 0 0 0;
        font-size: 0.9rem;
      }
      
      .auth-tabs {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 1.5rem;
        border-bottom: 2px solid var(--bg-input);
      }
      
      .auth-tab-btn {
        flex: 1;
        padding: 0.75rem;
        border: none;
        background: transparent;
        color: var(--gray-500);
        font-size: 1rem;
        font-weight: 500;
        cursor: pointer;
        border-bottom: 3px solid transparent;
        transition: all 0.2s ease;
      }
      
      .auth-tab-btn.active {
        color: var(--primary);
        border-bottom-color: var(--primary);
      }
      
      .auth-tab {
        display: none;
      }
      
      .auth-tab.active {
        display: block;
      }
      
      .auth-tab form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      
      .form-group {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      
      .form-group label {
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--text-primary);
      }
      
      .form-group input {
        padding: 0.75rem;
        border: 1px solid var(--border-color);
        border-radius: 6px;
        font-size: 1rem;
        font-family: inherit;
        background: var(--bg-input);
      }
      
      .form-group input:focus {
        outline: none;
        border-color: var(--primary);
        background: white;
      }
      
      .auth-submit-btn {
        padding: 0.75rem 1rem;
        background: var(--primary);
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      
      .auth-submit-btn:hover {
        background: var(--primary-dark, #4f46e5);
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
      
      .auth-submit-btn:active {
        transform: translateY(0);
      }
      
      .auth-error {
        padding: 0.75rem;
        background: #fee;
        color: #c33;
        border: 1px solid #fcc;
        border-radius: 6px;
        font-size: 0.9rem;
        margin-top: 1rem;
      }
      
      .auth-error.hidden {
        display: none;
      }
      
      .auth-loading {
        text-align: center;
        color: var(--gray-500);
        margin-top: 1rem;
      }
      
      .auth-loading.hidden {
        display: none;
      }
      
      /* ---- UPDATE TOPBAR FOR AUTH ---- */
      header.topbar.hidden,
      main.main-content.hidden {
        display: none;
      }
      ```
      
      Also add a logout button style (if not already present in nav buttons):
      
      ```css
      .nav-btn[data-page="logout"] {
        background: #fee;
        color: #c33;
      }
      
      .nav-btn[data-page="logout"]:hover {
        background: #fcc;
      }
      ```
      
      Files: `public/style.css`
      
      Verify:
      ```bash
      npm start
      # Open browser to http://localhost:3000
      # Auth screen should be centered, styled nicely
      # Form inputs should have proper styling
      # Logout button should have distinct styling
      # Tab switching should work smoothly
      ```

### Phase 9: Data Migration at Startup (1 item)

- [ ] **9. Add startup migration to link existing members to first user**
      
      In `src/db.js`, export a new function `migrateExistingMembers()`:
      
      ```javascript
      async function migrateExistingMembers() {
        try {
          // Get the first (admin) user if one exists
          const firstUser = await queryOne('SELECT id FROM users WHERE is_admin=1 LIMIT 1');
          if (!firstUser) {
            console.log('ℹ️  No admin user found; skipping member migration.');
            return;
          }
          
          // Link any unlinked members to the admin user
          const result = await queryOne('SELECT COUNT(*) as n FROM members WHERE user_id IS NULL OR user_id=\'\'');
          const unlinkedCount = result?.n || 0;
          
          if (unlinkedCount > 0) {
            await run('UPDATE members SET user_id=$1 WHERE user_id IS NULL OR user_id=\'\'', [firstUser.id]);
            console.log(`✅ Migrated ${unlinkedCount} existing members to admin user ${firstUser.id}`);
          } else {
            console.log('ℹ️  All members already linked to a user.');
          }
        } catch (err) {
          console.error('Member migration error:', err);
        }
      }
      
      module.exports = {
        uid,
        SCHEMA,
        SCHEMA2,
        SCHEMA3,
        initDb,
        getDb,
        query,
        queryOne,
        run,
        migrateExistingMembers,  // Add export
      };
      ```
      
      In `server.js`, after `await initDb()` in the `start()` function, add:
      
      ```javascript
      const { migrateExistingMembers } = require('./src/db.js');
      
      async function start() {
        try {
          await initDb();
          await migrateExistingMembers();  // Add this line
          
          // Only seed demo data if using SQLite (not PostgreSQL)
          const isPostgres = !!process.env.DATABASE_URL;
          if (!isPostgres) {
            await seedDemo();
          }
          // ... rest of start function
        }
      }
      ```
      
      Files: `src/db.js`, `server.js`
      
      Verify:
      ```bash
      npm start
      # Should show migration log: "✅ Migrated X existing members to admin user ..."
      # Or: "ℹ️  All members already linked to a user."
      # Log in with the first admin user
      # Should see all existing members (Prasath Murugesan, KeshavShree, AbinayaPradha R)
      ```

### Phase 10: Environment & Documentation (1 item)

- [ ] **10. Add SESSION_SECRET to .env template and update README**
      
      Update `.env` file to include:
      ```
      NODE_ENV=production
      PORT=3000
      
      # Session secret for authentication (change in production)
      SESSION_SECRET=fd-portfolio-dev-secret-change-in-prod
      
      # Database Configuration
      # For Railway PostgreSQL deployment:
      #   DATABASE_URL=postgresql://user:password@host:port/database
      ```
      
      In `README.md`, add a new section after "Local Development":
      
      ```markdown
      ## Authentication
      
      The app now includes user authentication. Users must sign up with an email and password, then log in to access their family's data. Each user's data is isolated; they only see their own family members and investment records.
      
      ### First User Migration
      
      When the first user signs up, all existing members in the database are automatically linked to that user. This preserves historical data during deployment.
      
      ### Session Management
      
      Sessions are managed via `express-session` with a configurable secret (see `SESSION_SECRET` in `.env`). In production, ensure:
      - `SESSION_SECRET` is set to a strong, random value
      - `secure` cookie flag is enabled (automatically set when `NODE_ENV=production`)
      - Cookie `httpOnly` flag is always enabled
      ```
      
      Files: `.env`, `README.md`
      
      Verify:
      ```bash
      # Review .env and README for clarity
      cat .env | grep SESSION_SECRET
      grep -i "authentication" README.md
      ```

## Startup & Verification Checklist

After all items are complete, run this verification sequence:

```bash
# 1. Install deps
npm install

# 2. Start server (SQLite mode for testing)
npm start

# 3. Browser: http://localhost:3000
#    - Should show auth screen
#    - Sign up: test@example.com / password123 / Test User
#    - Should see existing members (Prasath, KeshavShree, AbinayaPradha)
#    - Verify topbar shows "Test User"

# 4. In browser dev tools console:
#    - Check for any errors
#    - Check that GET /api/members returns only user's members

# 5. Click logout
#    - Auth screen should return

# 6. Login with same credentials
#    - Should show same data

# 7. Test with PostgreSQL (if DATABASE_URL set):
#    DATABASE_URL=postgresql://... npm start
#    - Should NOT seed demo data
#    - Should show successful PostgreSQL connection
#    - First signup should link existing members
```

## Summary

- **Total items**: 10
- **Database changes**: users table, user_id column on members/goals/etc.
- **Dependencies**: bcryptjs, express-session
- **Auth routes**: /api/auth/signup, /api/auth/login, /api/auth/logout, /api/auth/me
- **Data scoping**: All /api/* routes now require authentication and filter by user_id
- **Frontend**: Auth screen with login/signup tabs, logout button, user name in topbar
- **Data preservation**: Existing members linked to first user on signup
- **Production-ready**: Session secret configurable, HTTPS-ready, PostgreSQL-compatible
