# Zahra HQ Google Bridge

Minimal backend for Zahra HQ Google integrations.

- Google Calendar: read-only
- Gmail: matches only existing Waiting On items
- Drive/Sheets: deliberate imports only
- State sync: one private `Zahra HQ State.json` in Drive
- No email sending
- No calendar writes
- No inbox-wide task generation

Render env vars:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `APP_BASE_URL`

OAuth redirect URI is `<APP_BASE_URL>/auth/google/callback`.
