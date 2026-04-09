# 🧵 Threads → Notion Sync
**MOONGI Studio** — Auto-sync Threads posts to Notion with engagement tracking

---

## Setup (5 minutes)

### 1. Install dependencies
```bash
cd threads-sync
npm install
```

### 2. Configure credentials
```bash
cp .env.example .env
```
Open `.env` and fill in:
- `THREADS_TOKEN` — from Graph API Explorer (threads.net)
- `THREADS_APP_SECRET` — from Meta Developer → Thread Scraper → App Settings → Basic
- `NOTION_TOKEN` — from notion.so/my-integrations → your integration
- `NOTION_DB_ID` — already set to your database

### 3. Connect Notion integration to your database
- Open your Threads Engagement Tracker in Notion
- Click `...` top right → **Connections** → add your integration

### 4. Run your first sync
```bash
npm run sync
```

---

## Usage

| Command | Description |
|---------|-------------|
| `npm run sync` | Run sync immediately |
| `npm run schedule` | Start scheduler (runs weekly + immediately) |
| `npm run logs` | Watch sync logs in real time |

---

## How it works

1. **Token management** — On first run, exchanges your short-lived token for a 60-day long-lived token automatically. Saves to `.token` file. Refreshes when within 7 days of expiry.

2. **Post fetching** — Pulls your last 50 posts from Threads API with full metadata: text, media URL, thumbnail, permalink, timestamps.

3. **Engagement data** — Fetches per-post insights (views, likes, replies, reposts, quotes) from the Threads insights endpoint.

4. **Duplicate detection** — Searches Notion by Post ID before writing. Creates new pages, updates existing ones with fresh metrics only.

5. **Rich page content** — Each Notion page contains:
   - Full post text (no truncation)
   - Embedded image (for image/carousel posts)
   - Video thumbnail + watch link (for video posts)
   - Clickable Threads permalink

6. **Weekly schedule** — Cron job fires every Monday at 9am by default. Change `CRON_SCHEDULE` in `.env` to adjust.

---

## Logs
All sync activity is written to `sync.log` in the same folder.
Watch live: `npm run logs`

---

## Notion database views
- **🏆 Top Performing** — sorted by total engagement
- **🖼️ Media Gallery** — visual grid with image covers
- **📅 Post Calendar** — posts by date
- **📊 By Performance** — board grouped by tier

---

## Troubleshooting

**Token errors** — Generate a fresh token from Graph API Explorer and update `THREADS_TOKEN` in `.env`. Delete `.token` file to force re-exchange.

**Notion connection errors** — Make sure your integration is connected to the database (Connections menu in Notion).

**Missing insights** — Some posts may return null insights. The script falls back to basic counts (like_count, replies_count etc.) from the post object.
