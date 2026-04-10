import axios from "axios";
import crypto from "crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// GBP requires the business.manage scope
export const GBP_SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
].join(" ");

export interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

// In-memory token store keyed by session/state (mirrors LinkedIn pattern)
const tokenStore = new Map<string, TokenData>();

export function generateAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: GBP_SCOPES,
    access_type: "offline",   // get a refresh_token
    prompt: "consent",        // force consent so refresh_token is always returned
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await axios.post(GOOGLE_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return {
    accessToken: res.data.access_token,
    refreshToken: res.data.refresh_token,
    expiresIn: res.data.expires_in,
  };
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await axios.post(GOOGLE_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return {
    accessToken: res.data.access_token,
    expiresIn: res.data.expires_in,
  };
}

export function storeToken(sessionId: string, data: TokenData): void {
  tokenStore.set(sessionId, data);
}

export function getToken(sessionId: string): TokenData | undefined {
  const token = tokenStore.get(sessionId);
  if (!token) return undefined;
  if (Date.now() > token.expiresAt) {
    tokenStore.delete(sessionId);
    return undefined;
  }
  return token;
}

export function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}

// Single global token — used when GOOGLE_REFRESH_TOKEN is set in env
// (same "skip OAuth" pattern as the LinkedIn server)
let globalToken: TokenData | null = null;
let globalRefreshToken: string | null = null;

export function setGlobalToken(accessToken: string, refreshToken?: string, expiresIn = 3600): void {
  globalToken = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  if (refreshToken) globalRefreshToken = refreshToken;
}

export function getGlobalToken(): TokenData | null {
  if (!globalToken) return null;
  if (Date.now() > globalToken.expiresAt) {
    globalToken = null;
    return null;
  }
  return globalToken;
}

export function getGlobalRefreshToken(): string | null {
  return globalRefreshToken;
}
