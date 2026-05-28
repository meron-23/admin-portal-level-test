# Admin Portal

The admin portal has been split into independent `frontend` and `backend` services. This separation allows you to host them on separate platforms like Vercel and Render.

## Folder Structure

```text
admin-portal/
├── backend/          # Node.js backend hosted on Render
│   ├── server.js     # API Server (HTTP/SMTP/pg completion sync)
│   ├── package.json  # Backend dependencies (pg)
│   └── .env.example  # Configuration variables
└── frontend/         # Static web client hosted on Vercel
    ├── index.html    # Admin Dashboard
    ├── login.html    # Sign in interface
    ├── app.js        # Core dashboard logic
    ├── login.js      # Sign in logic
    ├── styles.css    # Premium CSS styling
    └── vercel.json   # Vercel routing & API proxy rewrite
```

---

## 1. Backend Hosting (Render)

To deploy the API backend to Render:

1. Create a new **Web Service** on Render.
2. Point it to this repository, and set the **Root Directory** to `admin-portal/backend`.
3. Set the **Build Command** to `npm install` and the **Start Command** to `npm start`.
4. Add the environment variables shown in `admin-portal/backend/.env.example` in the Render dashboard:
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` (Your choice of credentials).
   - `SESSION_SECRET` (A strong random string).
   - `DATABASE_URL` (Connection string of your main level-test PostgreSQL database to sync completions).
   - `TEST_APP_URL` (URL of the main English quiz/level-test website).
   - `PUBLIC_BASE_URL` (The public URL of this Render Web Service itself - used for private link generation).
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` (SMTP credentials for invitation emails).

---

## 2. Frontend Hosting (Vercel)

To deploy the client dashboard to Vercel:

1. Create a new project on Vercel and connect your repository.
2. Set the **Root Directory** to `admin-portal/frontend`.
3. Vercel will auto-detect it as a static project. No build command is required.
4. **Important**: Before deploying, update the rewrite destination in `vercel.json`:
   ```json
   {
     "cleanUrls": true,
     "rewrites": [
       {
         "source": "/api/:path*",
         "destination": "https://your-render-backend-url.onrender.com/api/:path*"
       }
     ]
   }
   ```
   Replace `https://your-render-backend-url.onrender.com` with the actual public URL of your Render backend. This proxies all `/api/*` calls from the Vercel app to your Render server, keeping authentication cookies working seamlessly.

---

## 3. Local Development

To run the admin portal locally:

### Run the Backend
```bash
cd admin-portal/backend
npm install
# Copy .env.example to .env and configure
npm start
```

### Run the Frontend
```bash
cd admin-portal/frontend
npm install
npm run dev
```
This starts the static frontend at `http://localhost:5000` with hot-module reloading and routes all `/api` calls straight to your local backend on port `4200` automatically.

