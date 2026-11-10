# Family Portfolio Manager (fd-portfolio)

A web application for managing family fixed deposits (FDs), bank accounts, PF, NPS, SIPs, and other investment records with a focus on financial security and ease of tracking.

## Features

- **Fixed Deposit Management**: Track principal, interest rates, maturity dates, and linked bank accounts
- **Family Members**: Organize FDs and accounts by family members with relationship tracking
- **Bank Accounts**: Store and link bank account details to FDs for easy maturity tracking
- **Investment Tracking**: Support for PF, NPS, SIPs, and other investment records
- **Audit Logs**: Full history of all changes for compliance and verification
- **CSV Import**: Bulk import FDs from CSV files
- **Alerts**: Get notified when FDs are maturing soon (within 90 days)
- **Maturity Calculations**: Automatic interest and maturity amount calculations based on compounding method

## Tech Stack

- **Backend**: Node.js + Express.js
- **Database**: PostgreSQL (production) or SQLite (local development)
- **Frontend**: Vanilla JavaScript, HTML, CSS
- **Database Driver**: `pg` (PostgreSQL client)

## Local Development

### Prerequisites

- Node.js 14+
- npm or yarn

### Setup

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm start
   ```

3. Open your browser to http://localhost:3000

**Note**: By default, data is stored in `portfolio.db` (SQLite) locally. No additional database setup is needed.

## Deployment on Railway

### Prerequisites

- Railway account (https://railway.app)
- PostgreSQL service in Railway

### Step 1: Set Up PostgreSQL on Railway

1. Log in to Railway
2. Create a new project
3. Add PostgreSQL plugin from the marketplace
4. Wait for the database to initialize (usually takes 1-2 minutes)

### Step 2: Deploy the Application

1. Connect your GitHub repository to Railway (or use Railway CLI)
2. Railway will auto-detect and deploy the Node.js app
3. Set the `PORT` environment variable if not already set (default: 3000)

### Step 3: Configure DATABASE_URL

1. In Railway, open your PostgreSQL service
2. Go to the **Variables** tab
3. Copy the connection string (it should look like):
   ```
   postgresql://user:password@containers-us-west-67.railway.app:8000/railway
   ```

4. In your app service, go to **Variables** tab
5. Click **New Variable** and add:
   - **Key**: `DATABASE_URL`
   - **Value**: Paste the PostgreSQL connection string

6. Deploy again (Railway will auto-redeploy when variables change)

### Step 4: Migrate Data (Optional)

If you have existing data in SQLite and want to migrate to PostgreSQL:

1. **Export data locally** (if needed):
   ```bash
   NODE_ENV=production node src/migrate.js
   ```
   This exports data to a JSON file in the `migrations/` directory.

2. **Load to Railway PostgreSQL**:
   ```bash
   DATABASE_URL="postgresql://user:password@host:port/database" node src/migrate.js
   ```

### Environment Variables

| Variable | Default | Required | Notes |
|----------|---------|----------|-------|
| `PORT` | 3000 | No | Port to run server on |
| `NODE_ENV` | production | No | Set to `production` for Railway |
| `DATABASE_URL` | – | No | PostgreSQL connection string. If not set, uses local SQLite. |

## API Endpoints

### Members
- `GET /api/members` - List all members
- `POST /api/members` - Create member
- `PUT /api/members/:id` - Update member
- `DELETE /api/members/:id` - Delete member

### Accounts
- `GET /api/accounts` - List all accounts
- `POST /api/accounts` - Create account
- `PUT /api/accounts/:id` - Update account
- `DELETE /api/accounts/:id` - Delete account

### Deposits (Fixed Deposits)
- `GET /api/deposits` - List all FDs
- `POST /api/deposits` - Create FD
- `PUT /api/deposits/:id` - Update FD
- `DELETE /api/deposits/:id` - Delete FD

### Audit Log
- `GET /api/history` - View all changes
- `DELETE /api/history` - Clear audit log

### CSV Import
- `POST /api/import/csv` - Import FDs from CSV

### Other Endpoints
- `GET /api/pf` - Provident Fund accounts
- `GET /api/nps` - NPS accounts
- `GET /api/sip` - SIP investments
- `GET /api/goals` - Financial goals
- `GET /api/others` - Other records

## Security & Data Privacy

⚠️ **Important**: This application stores sensitive financial information. When deploying:

1. **Use HTTPS**: Railway provides automatic HTTPS on custom domains
2. **Secure DATABASE_URL**: Only set in Railway Variables, never commit to git
3. **Access Control**: Implement authentication if exposing to the internet
4. **Backups**: Enable Railway's backup feature for PostgreSQL
5. **Audit Logs**: Monitor the audit log regularly for unauthorized changes

## Data Structure

### Members Table
- `id`: Unique identifier
- `name`: Family member name
- `relation`: Relationship to primary member (Spouse, Child, Parent, etc.)
- `pan`: PAN (Personal Account Number) for India
- `phone`: Contact number
- `email`: Email address
- `notes`: Additional notes

### Deposits (FDs) Table
- `id`: Unique identifier
- `member_id`: FK to member
- `bank`: Bank name
- `principal`: Investment amount
- `rate`: Interest rate (% per annum)
- `compounding`: Compounding method (simple, monthly, quarterly, annual)
- `start_date`: FD opening date
- `maturity_date`: FD maturity date
- `payout`: Interest payout type (cumulative or quarterly)
- `linked_account_id`: FK to bank account for maturity payout

### Accounts Table
- `id`: Unique identifier
- `member_id`: FK to member
- `bank`: Bank name
- `acct_number`: Account number (last 4 digits shown in UI)
- `acct_type`: Savings/Current/Salary/etc.
- `ifsc`: IFSC code
- `is_primary`: Flag for primary account
- `notes`: Additional notes

## Contributing

To contribute, create a feature branch and submit a pull request.

## License

Proprietary - Family Portfolio Manager

---

**Last Updated**: November 2026
