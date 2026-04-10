import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import {
  generateAuthUrl,
  generateState,
  exchangeCodeForToken,
  refreshAccessToken,
  storeToken,
  getToken,
  setGlobalToken,
  getGlobalToken,
  getGlobalRefreshToken,
  TokenData,
} from "./auth.js";

import {
  listAccounts,
  getAccount,
  listLocations,
  getLocation,
  updateLocation,
  listReviews,
  getReview,
  replyToReview,
  deleteReviewReply,
  listPosts,
  createPost,
  deletePost,
  listQuestions,
  answerQuestion,
  listMedia,
  getInsights,
} from "./gbp.js";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

// If you already have a refresh token, set it here to skip OAuth flow
if (process.env.GOOGLE_REFRESH_TOKEN) {
  setGlobalToken("pending", process.env.GOOGLE_REFRESH_TOKEN, 0); // will refresh on first use
  console.log("[auth] Loaded refresh token from environment — will auto-refresh on first call");
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1); // Required behind Railway's reverse proxy
app.use(cookieParser());
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS", "DELETE"], allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"] }));
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: BASE_URL.startsWith("https"), sameSite: "lax", maxAge: 3600000 },
  })
);

declare module "express-session" {
  interface SessionData {
    oauthState?: string;
    gbpToken?: TokenData;
  }
}

// ── Helper: resolve + auto-refresh access token ───────────────────────────────

async function resolveToken(req: express.Request): Promise<string> {
  // Try global token (from env GOOGLE_REFRESH_TOKEN)
  const global = getGlobalToken();
  if (global && global.accessToken !== "pending") return global.accessToken;

  // If global token expired or pending, try refreshing with stored refresh token
  const refreshToken = getGlobalRefreshToken();
  if (refreshToken && CLIENT_ID && CLIENT_SECRET) {
    const { accessToken, expiresIn } = await refreshAccessToken(CLIENT_ID, CLIENT_SECRET, refreshToken);
    setGlobalToken(accessToken, refreshToken, expiresIn);
    return accessToken;
  }

  // Try session token
  const sessionToken = req.session.gbpToken;
  if (sessionToken && Date.now() < sessionToken.expiresAt) {
    return sessionToken.accessToken;
  }

  throw new McpError(
    ErrorCode.InvalidRequest,
    "Not authenticated. Visit /auth/login to connect your Google Business Profile account."
  );
}

// ── OAuth routes ──────────────────────────────────────────────────────────────

app.get("/auth/login", (req, res) => {
  if (!CLIENT_ID) {
    res.status(500).send("GOOGLE_CLIENT_ID is not configured.");
    return;
  }
  const state = generateState();
  req.session.oauthState = state;
  res.cookie("oauth_state", state, {
    httpOnly: true,
    secure: BASE_URL.startsWith("https"),
    sameSite: "lax",
    maxAge: 600000, // 10 minutes
  });
  const authUrl = generateAuthUrl(CLIENT_ID, REDIRECT_URI, state);
  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    res.status(400).send(`Google auth error: ${error_description || error}`);
    return;
  }

  const cookieState = req.cookies?.oauth_state;
  const sessionState = req.session.oauthState;
  if (state !== cookieState && state !== sessionState) {
    res.status(400).send("Invalid OAuth state — possible CSRF. Please try again.");
    return;
  }
  res.clearCookie("oauth_state");

  try {
    const { accessToken, refreshToken, expiresIn } = await exchangeCodeForToken(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI,
      code
    );

    const tokenData: TokenData = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    req.session.gbpToken = tokenData;
    storeToken(state, tokenData);

    res.send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
        <h2>✅ Connected to Google Business Profile!</h2>
        <p>Your account is now linked. You can close this tab and return to Claude.</p>
        <p><strong>Your refresh token (save this as GOOGLE_REFRESH_TOKEN env var to skip OAuth next time):</strong></p>
        <code style="background:#f0f0f0;padding:10px;display:block;word-break:break-all">${refreshToken}</code>
        <p style="margin-top:20px"><a href="${BASE_URL}/">← Back to server info</a></p>
      </body></html>
    `);
  } catch (err: any) {
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

app.get("/auth/status", async (req, res) => {
  try {
    const accessToken = await resolveToken(req);
    const accounts = await listAccounts(accessToken);
    res.json({ authenticated: true, accountCount: accounts.length });
  } catch {
    res.json({ authenticated: false, loginUrl: `${BASE_URL}/auth/login` });
  }
});

// ── MCP tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "gbp_auth_status",
    description: "Check whether your Google Business Profile account is connected and the token is valid.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "gbp_list_accounts",
    description: "List all Google Business Profile accounts you have access to.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "gbp_list_locations",
    description: "List all locations (business listings) for a GBP account.",
    inputSchema: {
      type: "object",
      properties: {
        account_name: { type: "string", description: "Account resource name, e.g. accounts/123456789" },
      },
      required: ["account_name"],
    },
  },
  {
    name: "gbp_get_location",
    description: "Get full details for a specific GBP location.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name, e.g. accounts/123/locations/456" },
      },
      required: ["location_name"],
    },
  },
  {
    name: "gbp_update_location",
    description: "Update business information for a GBP location (hours, phone, website, description, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
        fields: {
          type: "object",
          description: "Fields to update as a JSON object. Common fields: title, phoneNumbers, websiteUri, regularHours, profile (description), storefrontAddress",
        },
      },
      required: ["location_name", "fields"],
    },
  },
  {
    name: "gbp_list_reviews",
    description: "Get reviews for a GBP location.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
        page_size: { type: "number", description: "Number of reviews to return (default 20, max 50)" },
      },
      required: ["location_name"],
    },
  },
  {
    name: "gbp_reply_to_review",
    description: "Reply to a customer review on a GBP location.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
        review_id: { type: "string", description: "Review ID from list_reviews" },
        comment: { type: "string", description: "Your reply text" },
      },
      required: ["location_name", "review_id", "comment"],
    },
  },
  {
    name: "gbp_delete_review_reply",
    description: "Delete your reply to a review.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
        review_id: { type: "string", description: "Review ID" },
      },
      required: ["location_name", "review_id"],
    },
  },
  {
    name: "gbp_list_posts",
    description: "List local posts (updates) for a GBP location.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
      },
      required: ["location_name"],
    },
  },
  {
    name: "gbp_create_post",
    description: "Create a local post (update, event, offer, or alert) on a GBP location.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
        topic_type: {
          type: "string",
          enum: ["STANDARD", "EVENT", "OFFER", "ALERT"],
          description: "Post type",
        },
        summary: { type: "string", description: "Post text content" },
        call_to_action_type: {
          type: "string",
          description: "CTA button type (optional): BOOK, ORDER, SHOP, LEARN_MORE, SIGN_UP, CALL",
        },
        call_to_action_url: { type: "string", description: "CTA button URL (optional)" },
        event_title: { type: "string", description: "Event title (required for EVENT posts)" },
        event_start: { type: "string", description: "Event start ISO date (required for EVENT posts)" },
        event_end: { type: "string", description: "Event end ISO date (required for EVENT posts)" },
        media_url: { type: "string", description: "Optional image URL to attach to post" },
      },
      required: ["location_name", "topic_type", "summary"],
    },
  },
  {
    name: "gbp_delete_post",
    description: "Delete a local post from a GBP location.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
        post_name: { type: "string", description: "Post resource name from list_posts" },
      },
      required: ["location_name", "post_name"],
    },
  },
  {
    name: "gbp_list_questions",
    description: "List customer Q&A questions for a GBP location.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
        page_size: { type: "number", description: "Number of questions to return (default 10)" },
      },
      required: ["location_name"],
    },
  },
  {
    name: "gbp_answer_question",
    description: "Answer a customer question on a GBP location.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
        question_name: { type: "string", description: "Question resource name from list_questions" },
        answer_text: { type: "string", description: "Your answer text" },
      },
      required: ["location_name", "question_name", "answer_text"],
    },
  },
  {
    name: "gbp_list_media",
    description: "List photos and media for a GBP location.",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
        page_size: { type: "number", description: "Number of media items to return (default 20)" },
      },
      required: ["location_name"],
    },
  },
  {
    name: "gbp_get_insights",
    description: "Get performance insights for a GBP location (views, searches, direction requests, calls, website clicks).",
    inputSchema: {
      type: "object",
      properties: {
        location_name: { type: "string", description: "Location resource name" },
        start_time: { type: "string", description: "Start date in ISO 8601 format, e.g. 2024-01-01T00:00:00Z" },
        end_time: { type: "string", description: "End date in ISO 8601 format, e.g. 2024-02-01T00:00:00Z" },
        metrics: {
          type: "array",
          items: { type: "string" },
          description: "Metrics to retrieve. Options: QUERIES_DIRECT, QUERIES_INDIRECT, VIEWS_MAPS, VIEWS_SEARCH, ACTIONS_WEBSITE, ACTIONS_PHONE, ACTIONS_DRIVING_DIRECTIONS, PHOTOS_VIEWS_MERCHANT, PHOTOS_COUNT_MERCHANT",
        },
      },
      required: ["location_name", "start_time", "end_time"],
    },
  },
];

// ── MCP server factory ────────────────────────────────────────────────────────

function createMcpServer(): Server {
  const server = new Server(
    { name: "gbp-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Express request is not available here directly — we resolve token via global store
    const { name, arguments: args = {} } = request.params;

    // For tool calls we always use the global token (env-based or previously set)
    async function getToken(): Promise<string> {
      const global = getGlobalToken();
      if (global && global.accessToken !== "pending") return global.accessToken;

      const refreshToken = getGlobalRefreshToken();
      if (refreshToken && CLIENT_ID && CLIENT_SECRET) {
        const { accessToken, expiresIn } = await refreshAccessToken(CLIENT_ID, CLIENT_SECRET, refreshToken);
        setGlobalToken(accessToken, refreshToken, expiresIn);
        return accessToken;
      }

      throw new McpError(
        ErrorCode.InvalidRequest,
        `Not authenticated. Visit ${BASE_URL}/auth/login to connect your Google Business Profile.`
      );
    }

    try {
      switch (name) {
        case "gbp_auth_status": {
          try {
            const token = await getToken();
            const accounts = await listAccounts(token);
            return {
              content: [{
                type: "text",
                text: `✅ Connected! Found ${accounts.length} account(s).\n\n${JSON.stringify(accounts.map((a: any) => ({ name: a.name, accountName: a.accountName, type: a.type })), null, 2)}`,
              }],
            };
          } catch {
            return {
              content: [{
                type: "text",
                text: `❌ Not authenticated. Visit ${BASE_URL}/auth/login to connect your Google Business Profile account.`,
              }],
            };
          }
        }

        case "gbp_list_accounts": {
          const token = await getToken();
          const accounts = await listAccounts(token);
          if (accounts.length === 0) return { content: [{ type: "text", text: "No GBP accounts found." }] };
          return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
        }

        case "gbp_list_locations": {
          const accountName = String(args.account_name || "");
          if (!accountName) return { content: [{ type: "text", text: "account_name is required." }], isError: true };
          const token = await getToken();
          const locations = await listLocations(token, accountName);
          if (locations.length === 0) return { content: [{ type: "text", text: "No locations found for this account." }] };
          return { content: [{ type: "text", text: JSON.stringify(locations, null, 2) }] };
        }

        case "gbp_get_location": {
          const locationName = String(args.location_name || "");
          if (!locationName) return { content: [{ type: "text", text: "location_name is required." }], isError: true };
          const token = await getToken();
          const location = await getLocation(token, locationName);
          return { content: [{ type: "text", text: JSON.stringify(location, null, 2) }] };
        }

        case "gbp_update_location": {
          const locationName = String(args.location_name || "");
          const fields = args.fields as Record<string, any>;
          if (!locationName || !fields) return { content: [{ type: "text", text: "location_name and fields are required." }], isError: true };
          const token = await getToken();
          const result = await updateLocation(token, locationName, fields);
          return { content: [{ type: "text", text: `✅ Location updated.\n\n${JSON.stringify(result, null, 2)}` }] };
        }

        case "gbp_list_reviews": {
          const locationName = String(args.location_name || "");
          const pageSize = Number(args.page_size) || 20;
          if (!locationName) return { content: [{ type: "text", text: "location_name is required." }], isError: true };
          const token = await getToken();
          const reviews = await listReviews(token, locationName, pageSize);
          if (reviews.length === 0) return { content: [{ type: "text", text: "No reviews found." }] };
          return { content: [{ type: "text", text: JSON.stringify(reviews, null, 2) }] };
        }

        case "gbp_reply_to_review": {
          const locationName = String(args.location_name || "");
          const reviewId = String(args.review_id || "");
          const comment = String(args.comment || "");
          if (!locationName || !reviewId || !comment) {
            return { content: [{ type: "text", text: "location_name, review_id, and comment are required." }], isError: true };
          }
          const token = await getToken();
          const result = await replyToReview(token, locationName, reviewId, comment);
          return { content: [{ type: "text", text: `✅ Reply posted.\n\n${JSON.stringify(result, null, 2)}` }] };
        }

        case "gbp_delete_review_reply": {
          const locationName = String(args.location_name || "");
          const reviewId = String(args.review_id || "");
          if (!locationName || !reviewId) return { content: [{ type: "text", text: "location_name and review_id are required." }], isError: true };
          const token = await getToken();
          await deleteReviewReply(token, locationName, reviewId);
          return { content: [{ type: "text", text: "✅ Review reply deleted." }] };
        }

        case "gbp_list_posts": {
          const locationName = String(args.location_name || "");
          if (!locationName) return { content: [{ type: "text", text: "location_name is required." }], isError: true };
          const token = await getToken();
          const posts = await listPosts(token, locationName);
          if (posts.length === 0) return { content: [{ type: "text", text: "No posts found." }] };
          return { content: [{ type: "text", text: JSON.stringify(posts, null, 2) }] };
        }

        case "gbp_create_post": {
          const locationName = String(args.location_name || "");
          const topicType = String(args.topic_type || "STANDARD") as "STANDARD" | "EVENT" | "OFFER" | "ALERT";
          const summary = String(args.summary || "");
          if (!locationName || !summary) return { content: [{ type: "text", text: "location_name and summary are required." }], isError: true };

          const postBody: any = { topicType, summary };

          if (args.call_to_action_type && args.call_to_action_url) {
            postBody.callToAction = {
              actionType: String(args.call_to_action_type),
              url: String(args.call_to_action_url),
            };
          }

          if (topicType === "EVENT" && args.event_title && args.event_start && args.event_end) {
            const startDate = new Date(String(args.event_start));
            const endDate = new Date(String(args.event_end));
            postBody.event = {
              title: String(args.event_title),
              schedule: {
                startDate: { year: startDate.getFullYear(), month: startDate.getMonth() + 1, day: startDate.getDate() },
                endDate: { year: endDate.getFullYear(), month: endDate.getMonth() + 1, day: endDate.getDate() },
              },
            };
          }

          if (args.media_url) {
            postBody.media = [{ mediaFormat: "PHOTO", sourceUrl: String(args.media_url) }];
          }

          const token = await getToken();
          const result = await createPost(token, locationName, postBody);
          return { content: [{ type: "text", text: `✅ Post created!\n\n${JSON.stringify(result, null, 2)}` }] };
        }

        case "gbp_delete_post": {
          const locationName = String(args.location_name || "");
          const postName = String(args.post_name || "");
          if (!locationName || !postName) return { content: [{ type: "text", text: "location_name and post_name are required." }], isError: true };
          const token = await getToken();
          await deletePost(token, locationName, postName);
          return { content: [{ type: "text", text: "✅ Post deleted." }] };
        }

        case "gbp_list_questions": {
          const locationName = String(args.location_name || "");
          const pageSize = Number(args.page_size) || 10;
          if (!locationName) return { content: [{ type: "text", text: "location_name is required." }], isError: true };
          const token = await getToken();
          const questions = await listQuestions(token, locationName, pageSize);
          if (questions.length === 0) return { content: [{ type: "text", text: "No questions found." }] };
          return { content: [{ type: "text", text: JSON.stringify(questions, null, 2) }] };
        }

        case "gbp_answer_question": {
          const locationName = String(args.location_name || "");
          const questionName = String(args.question_name || "");
          const answerText = String(args.answer_text || "");
          if (!locationName || !questionName || !answerText) {
            return { content: [{ type: "text", text: "location_name, question_name, and answer_text are required." }], isError: true };
          }
          const token = await getToken();
          const result = await answerQuestion(token, locationName, questionName, answerText);
          return { content: [{ type: "text", text: `✅ Answer posted.\n\n${JSON.stringify(result, null, 2)}` }] };
        }

        case "gbp_list_media": {
          const locationName = String(args.location_name || "");
          const pageSize = Number(args.page_size) || 20;
          if (!locationName) return { content: [{ type: "text", text: "location_name is required." }], isError: true };
          const token = await getToken();
          const media = await listMedia(token, locationName, pageSize);
          if (media.length === 0) return { content: [{ type: "text", text: "No media found." }] };
          return { content: [{ type: "text", text: JSON.stringify(media, null, 2) }] };
        }

        case "gbp_get_insights": {
          const locationName = String(args.location_name || "");
          const startTime = String(args.start_time || "");
          const endTime = String(args.end_time || "");
          const metrics = Array.isArray(args.metrics)
            ? (args.metrics as string[])
            : ["QUERIES_DIRECT", "QUERIES_INDIRECT", "VIEWS_MAPS", "VIEWS_SEARCH", "ACTIONS_WEBSITE", "ACTIONS_PHONE", "ACTIONS_DRIVING_DIRECTIONS"];

          if (!locationName || !startTime || !endTime) {
            return { content: [{ type: "text", text: "location_name, start_time, and end_time are required." }], isError: true };
          }

          const token = await getToken();
          const metricRequests = metrics.map((m) => ({ metric: m }));
          const result = await getInsights(token, [locationName], startTime, endTime, metricRequests);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err: any) {
      const message =
        err instanceof McpError
          ? err.message
          : err.response?.data?.error?.message || err.response?.data?.message || err.message || String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Streamable HTTP MCP endpoint (MCP spec 2025-03-26) ────────────────────────

const activeTransports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcp(req: express.Request, res: express.Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && activeTransports.has(sessionId)) {
    const transport = activeTransports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (req.method === "GET" || (req.method === "POST" && !sessionId)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: false,
    });

    const server = createMcpServer();
    await server.connect(transport);

    transport.onclose = () => {
      if (transport.sessionId) {
        activeTransports.delete(transport.sessionId);
        console.log(`[mcp] Session closed: ${transport.sessionId}`);
      }
    };

    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId) {
      activeTransports.set(transport.sessionId, transport);
      console.log(`[mcp] New session: ${transport.sessionId}`);
    }
    return;
  }

  res.status(400).json({ error: "Bad request" });
}

// GET /mcp — serve SSE stream or return JSON for health checks
app.get("/mcp", async (req, res) => {
  const accept = req.headers.accept ?? "";
  if (!accept.includes("text/event-stream")) {
    res.json({
      name: "gbp-mcp",
      version: "1.0.0",
      transport: "streamable-http",
      mcpEndpoint: `${BASE_URL}/mcp`,
      status: "ready",
    });
    return;
  }

  // SSE keep-alive pings every 20s (Railway's proxy timeout is 30s)
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const pingInterval = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 20000);

  res.on("close", () => clearInterval(pingInterval));

  await handleMcp(req, res);
});

app.post("/mcp", handleMcp);

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && activeTransports.has(sessionId)) {
    await activeTransports.get(sessionId)!.close();
    activeTransports.delete(sessionId);
    res.status(200).json({ ok: true });
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// ── Health & info ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    name: "Google Business Profile MCP Server",
    version: "1.0.0",
    status: "running",
    endpoints: {
      mcp: `${BASE_URL}/mcp`,
      auth_login: `${BASE_URL}/auth/login`,
      auth_status: `${BASE_URL}/auth/status`,
      health: `${BASE_URL}/health`,
    },
    instructions: {
      step1: `Visit ${BASE_URL}/auth/login to connect your Google account`,
      step2: `Add MCP server in Claude with URL: ${BASE_URL}/mcp`,
      alternative: "Or set GOOGLE_REFRESH_TOKEN env var to skip OAuth entirely",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 GBP MCP Server running on port ${PORT}`);
  console.log(`   Home:        ${BASE_URL}/`);
  console.log(`   MCP:         ${BASE_URL}/mcp`);
  console.log(`   Auth login:  ${BASE_URL}/auth/login`);
  console.log(`   Auth status: ${BASE_URL}/auth/status\n`);

  // Self-ping every 4 min to keep Railway from sleeping
  const PING_INTERVAL_MS = 4 * 60 * 1000;
  setInterval(async () => {
    try {
      const http = await import("http");
      const url = new URL(`${BASE_URL}/health`);
      http.get({ hostname: url.hostname, path: url.pathname, port: url.port || 80 }, (r) => {
        r.resume();
      }).on("error", () => {});
    } catch {}
  }, PING_INTERVAL_MS);
});
