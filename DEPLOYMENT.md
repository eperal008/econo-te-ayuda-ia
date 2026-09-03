# Econo Te Ayuda IA — Deployment (your accounts, demo)

Stack: **Frontend → Netlify**, **Backend → Heroku**, **Postgres (pgvector)** → Neon (free) or Heroku Postgres.
Deploying to your own accounts now; transfer to the customer later (see Handover at the bottom).

---

## 0. Push code to GitHub (private)
```bash
cd "33. Econo Te Ayuda IA"
gh repo create econo-te-ayuda-ia --private --source . --remote origin
git push -u origin main
```
(`.env` is git-ignored — secrets are NOT pushed. Set them directly on Heroku/Netlify.)

## 1. Provision the database (pgvector)
**Option A — Neon (free, recommended):** create a project at neon.tech → copy the connection string (`postgres://…?sslmode=require`).
**Option B — Heroku Postgres:** `heroku addons:create heroku-postgresql:essential-0 -a your-store-kiosk-api` (~$5/mo; confirm pgvector is available).

## 2. Load the data into the cloud DB (run locally, pointed at the cloud DB)
```bash
cd backend
# temporarily point at the cloud DB:
DATABASE_URL="<cloud-postgres-url>" PGSSL=true node scripts/ingest.js     # schema + 1480 products
DATABASE_URL="<cloud-postgres-url>" PGSSL=true node scripts/embed.js      # embeddings (~5 min)
```
(`ingest.js` runs `schema.sql`, which creates the pgvector extension + tables.)

## 3. Deploy the backend to Heroku (the backend/ subfolder)
```bash
heroku git:remote -a your-store-kiosk-api          # link the existing app
# config vars (copy the real values from backend/.env):
heroku config:set -a your-store-kiosk-api \
  DATABASE_URL="<cloud-postgres-url>" PGSSL=true \
  OPENAI_API_KEY="…" CLOUDINARY_CLOUD_NAME="dll6qriyg" CLOUDINARY_API_KEY="…" CLOUDINARY_API_SECRET="…" \
  ADMIN_USERNAME="eperal01" ADMIN_PASSWORD="…" ADMIN_API_KEY="…" DEFAULT_STORE_ID="ECONO-SIERRA-BAYAMON"
# GOOGLE_CREDENTIALS must be the full service-account JSON on one line:
heroku config:set -a your-store-kiosk-api GOOGLE_CREDENTIALS="$(cat path/to/service-account.json | tr -d '\n')"
# deploy ONLY the backend subfolder:
git subtree push --prefix backend heroku main
```
Verify: `https://your-store-kiosk-api-XXXX.herokuapp.com/health` → `{"ok":true,...}`

## 4. Deploy the frontend to Netlify
- Connect the GitHub repo in Netlify (build settings come from `netlify.toml`), **or** drag-drop the `build/` folder.
- Set env var **`REACT_APP_API_BASE_URL`** = your Heroku backend URL, then trigger a deploy.
- The kiosk is at `/`, the admin at `/admin`.

## 5. Post-deploy checks
- Backend `/health` returns product/zone counts.
- Kiosk: a product search, a recipe, a language switch, mic, camera.
- Admin: log in, edit a price, review misses.
- Tighten CORS in `backend/server.js` to the Netlify domain before sharing widely.

---

## Handover (later — move to customer-owned accounts)
Rotate ALL secrets and move billing to the customer: new email → their Heroku, Netlify, Postgres,
Cloudinary, OpenAI, Google Cloud. Change the admin password. Re-run steps 1–4 on their accounts.
