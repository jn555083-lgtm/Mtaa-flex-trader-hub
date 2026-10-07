import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const app = express();
const prisma = new PrismaClient();

app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173", credentials: true }));
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

const PORT = Number(process.env.PORT || 4000);
const API = "https://api.derivws.com";
const AUTH = "https://auth.deriv.com/oauth2";

function base64url(buf: Buffer) {
  return buf.toString("base64").replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

const oauthSessions = new Map<string, { verifier: string; created: number }>();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "mtaaflex-api", time: new Date().toISOString() });
});

app.get("/api/auth/deriv/start", (_req, res) => {
  const clientId = process.env.DERIV_CLIENT_ID;
  const redirectUri = process.env.DERIV_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return res.status(503).json({ error: "Deriv OAuth is not configured yet." });
  }

  const state = base64url(crypto.randomBytes(32));
  const { verifier, challenge } = pkcePair();
  oauthSessions.set(state, { verifier, created: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "trade account_manage",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });

  res.redirect(`${AUTH}/auth?${params.toString()}`);
});

app.get("/api/auth/deriv/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Deriv authorization failed: ${error}`);
  if (typeof state !== "string" || typeof code !== "string") {
    return res.status(400).send("Missing OAuth callback parameters.");
  }

  const session = oauthSessions.get(state);
  oauthSessions.delete(state);
  if (!session || Date.now() - session.created > 10 * 60_000) {
    return res.status(400).send("Invalid or expired OAuth state.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.DERIV_CLIENT_ID || "",
    code,
    code_verifier: session.verifier,
    redirect_uri: process.env.DERIV_REDIRECT_URI || ""
  });

  const tokenResponse = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!tokenResponse.ok) {
    return res.status(502).send("Deriv token exchange failed.");
  }

  const token = await tokenResponse.json();

  // Production: encrypt token before persistence and establish an HttpOnly session.
  // This starter deliberately does not expose the token to the browser.
  res.status(200).send(`
    <html><body style="font-family:sans-serif;background:#080b12;color:white;padding:40px">
    <h2>Deriv connected</h2>
    <p>OAuth completed successfully. Finish server session persistence before enabling live trading.</p>
    <pre>${JSON.stringify({ token_type: token.token_type, expires_in: token.expires_in }, null, 2)}</pre>
    </body></html>
  `);
});

app.get("/api/market/ticks/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  const wsUrl = "wss://api.derivws.com/trading/v1/options/ws/public";
  res.json({
    symbol,
    websocket: wsUrl,
    message: "Connect to the public Deriv WebSocket and subscribe to ticks for this symbol."
  });
});

app.get("/api/scanner/digits", (req, res) => {
  const symbol = String(req.query.symbol || "1HZ100V");
  const digits = Array.from({ length: 10 }, (_, digit) => ({
    digit,
    probability: 10,
    signal: "NEUTRAL"
  }));
  res.json({
    symbol,
    method: "rolling digit-frequency baseline",
    warning: "This is statistical analysis, not a guaranteed prediction.",
    digits
  });
});

app.get("/api/community/posts", async (_req, res) => {
  const posts = await prisma.communityPost.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { user: { select: { displayName: true } } }
  });
  res.json(posts);
});

app.post("/api/community/posts", async (req, res) => {
  const { userId, content } = req.body;
  if (!userId || typeof content !== "string" || content.trim().length < 1) {
    return res.status(400).json({ error: "Invalid post." });
  }
  const post = await prisma.communityPost.create({
    data: { userId, content: content.trim().slice(0, 2000) }
  });
  res.status(201).json(post);
});

app.get("/api/bots", async (_req, res) => {
  const bots = await prisma.bot.findMany({ take: 100, orderBy: { createdAt: "desc" } });
  res.json(bots);
});

app.post("/api/bots", async (req, res) => {
  const { userId, name, strategy, maxStake, stopLoss, takeProfit } = req.body;
  if (!userId || !name || !strategy) return res.status(400).json({ error: "Missing bot fields." });
  const bot = await prisma.bot.create({
    data: {
      userId, name: String(name).slice(0, 100), strategy: String(strategy).slice(0, 100),
      maxStake: Math.min(Number(maxStake) || 0.35, 0.35),
      stopLoss: Math.max(Number(stopLoss) || 5, 0),
      takeProfit: Math.max(Number(takeProfit) || 5, 0)
    }
  });
  res.status(201).json(bot);
});

app.listen(PORT, () => console.log(`MtaaFlex API running on :${PORT}`));
