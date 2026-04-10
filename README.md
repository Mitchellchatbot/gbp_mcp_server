# Google Business Profile MCP Server

A Model Context Protocol (MCP) server for Google Business Profile, built to deploy on Railway and connect to Claude — same pattern as the LinkedIn MCP server.

## Tools Available

| Tool | Description |
|------|-------------|
| `gbp_auth_status` | Check connection status |
| `gbp_list_accounts` | List all GBP accounts |
| `gbp_list_locations` | List locations for an account |
| `gbp_get_location` | Get full location details |
| `gbp_update_location` | Update business info (hours, phone, website, etc.) |
| `gbp_list_reviews` | Get customer reviews |
| `gbp_reply_to_review` | Reply to a review |
| `gbp_delete_review_reply` | Delete a review reply |
| `gbp_list_posts` | List local posts/updates |
| `gbp_create_post` | Create a post (standard, event, offer, alert) |
| `gbp_delete_post` | Delete a post |
| `gbp_list_questions` | List customer Q&A |
| `gbp_answer_question` | Answer a customer question |
| `gbp_list_media` | List photos and media |
| `gbp_get_insights` | Get performance insights |

## Setup

### 1. Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Enable these APIs:
   - **My Business Business Information API**
   - **My Business Account Management API**
   - **My Business Q&A API**
   - **My Business Notifications API** (optional)
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Web Application**
6. Add authorized redirect URI: `https://your-railway-app.up.railway.app/auth/callback`
7. Save your `CLIENT_ID` and `CLIENT_SECRET`

### 2. Deploy to Railway

1. Push this repo to GitHub
2. In Railway: **New Project → Deploy from GitHub repo**
3. Add environment variables:
   ```
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   SESSION_SECRET=any-random-string
   BASE_URL=https://your-railway-app.up.railway.app
   ```
4. After deploy, copy your Railway public URL

### 3. Authenticate

**Option A — OAuth flow (first time):**
1. Visit `https://your-railway-app.up.railway.app/auth/login`
2. Sign in with your Google account
3. The callback page shows your **refresh token** — copy it
4. Add `GOOGLE_REFRESH_TOKEN=<that token>` to Railway env vars
5. Redeploy — now it auto-authenticates on startup, no more OAuth needed

**Option B — Skip OAuth entirely:**
Use [Google OAuth Playground](https://developers.google.com/oauthplayground/):
1. Set scope: `https://www.googleapis.com/auth/business.manage`
2. Exchange for tokens
3. Set `GOOGLE_REFRESH_TOKEN` directly in Railway

### 4. Add to Claude

In Claude.ai → Settings → Connectors → Add MCP server:
```
https://your-railway-app.up.railway.app/mcp
```

## Local Development

```bash
cp .env.example .env
# Fill in your credentials
npm install
npm run dev
```

Visit `http://localhost:3000/auth/login` to authenticate.
