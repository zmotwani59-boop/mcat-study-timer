# Clockify → Notion live study timer

This widget displays the currently running Clockify entry and ticks locally every second. It checks Clockify every three minutes to detect starts, stops, and task-name changes. Use the **Refresh now** button after starting or stopping a timer when you want the dashboard to update immediately.

The three-minute refresh interval keeps the widget below Clockify Free's API limit of 30 requests per hour: this version makes one Clockify API request per refresh, or about 20 per hour.

## Required Vercel environment variables

- `CLOCKIFY_API_KEY` — generate this in Clockify. Keep it private.
- `CLOCKIFY_WORKSPACE_ID` — your Clockify workspace ID.
- `CLOCKIFY_API_BASE` — optional. Leave unset for the global API. If your Clockify workspace uses a regional API host, enter that API base ending in `/api/v1`.

## Deploy without using Terminal

1. In Vercel, select **Add New → Project** and import this repository.
2. Add the environment variables above in **Settings → Environment Variables**.
3. Deploy or redeploy.
4. Open the Vercel production URL.
5. In Notion, type `/embed`, paste the production URL, and resize the block.

Never put the Clockify API key in `index.html` or any browser-visible code.
