// Resenha demo voice-bot orchestrator.
//
// Runs one headless Chromium per bot. Each browser is launched with a fake
// audio device backed by a WAV file (Chrome loops it automatically), logs in as
// the bot user, then cycles forever: join the room -> stay connected while the
// file plays -> leave -> pause -> repeat.
//
// Because Resenha is pure peer-to-peer WebRTC, the audio only reaches a human
// once they join the room; running >= 2 bots per room makes the room visibly
// "alive" (speaking indicators) even before anyone listens, since the bots peer
// with each other.
//
// Config comes from the resenha-bots plugin endpoint; see README.md.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const SITE_URL = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.RESENHA_BOTS_API_KEY;
const API_USERNAME = process.env.RESENHA_BOTS_API_USERNAME || "system";
const AUDIO_DIR = process.env.RESENHA_BOTS_AUDIO_DIR || "/shared/resenha-bots/audio";
const HEADLESS = process.env.RESENHA_BOTS_HEADLESS !== "false";
const RESTART_BACKOFF_MS = Number(process.env.RESENHA_BOTS_RESTART_BACKOFF_MS || 15000);
const CONFIG_RETRY_MS = Number(process.env.RESENHA_BOTS_CONFIG_RETRY_MS || 30000);
const PARTICIPANT_POLL_MS = Number(process.env.RESENHA_BOTS_PARTICIPANT_POLL_MS || 3000);

let shuttingDown = false;
const activeBrowsers = new Set();

function log(scope, message) {
  // eslint-disable-next-line no-console
  console.log(`[resenha-bots] ${scope}: ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchConfig() {
  if (!API_KEY) {
    throw new Error("RESENHA_BOTS_API_KEY is not set");
  }

  const response = await fetch(`${SITE_URL}/resenha-bots/config.json`, {
    headers: { "Api-Key": API_KEY, "Api-Username": API_USERNAME },
  });

  if (!response.ok) {
    throw new Error(`config endpoint returned ${response.status}`);
  }

  return response.json();
}

// Download the bot's audio to a local WAV once (cached by URL hash). Chrome's
// fake mic needs a local file path, and the file must already be 16-bit PCM WAV.
async function ensureAudio(audioUrl) {
  await fs.mkdir(AUDIO_DIR, { recursive: true });

  const absoluteUrl = audioUrl.startsWith("http") ? audioUrl : `${SITE_URL}${audioUrl}`;
  const hash = crypto.createHash("sha1").update(absoluteUrl).digest("hex");
  const target = path.join(AUDIO_DIR, `${hash}.wav`);

  try {
    await fs.access(target);
    return target;
  } catch {
    // not cached yet
  }

  const response = await fetch(absoluteUrl);
  if (!response.ok) {
    throw new Error(`failed to download audio ${absoluteUrl}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(target, buffer);
  return target;
}

async function login(page, bot) {
  await page.goto(`${SITE_URL}/login`, { waitUntil: "domcontentloaded" });

  // /login opens the login form (modal or full page depending on config).
  await page.waitForSelector("#login-account-name", { timeout: 30000 });
  await page.fill("#login-account-name", bot.username);
  await page.fill("#login-account-password", bot.password);

  // Capture the auth response so we can report *why* login failed. Discourse
  // returns HTTP 200 with an error/2FA body for bad credentials, unactivated
  // accounts, or a required second factor — a 200 is not proof of success.
  let authResponse;
  try {
    [authResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/session") && r.request().method() === "POST",
        { timeout: 30000 }
      ),
      page.click("#login-button"),
    ]);
  } catch {
    throw new Error("login form did not submit (no POST /session response)");
  }

  let body = {};
  try {
    body = await authResponse.json();
  } catch {
    // non-JSON response (e.g. an HTML error page) — leave body empty
  }
  if (body && (body.error || body.failed)) {
    throw new Error(`login rejected: ${body.error || body.failed}`);
  }

  // Confirm the session is actually authenticated. /session/current.json
  // returns 200 only when logged in (404 when anon) — a version-stable signal,
  // unlike header selectors which change between Discourse releases.
  for (let attempt = 0; attempt < 10; attempt++) {
    let status = 0;
    try {
      status = await page.evaluate(async () => {
        const res = await fetch("/session/current.json", {
          headers: { Accept: "application/json" },
        });
        return res.status;
      });
    } catch {
      // page may be mid-navigation right after login; retry
    }
    if (status === 200) {
      return;
    }
    await sleep(1000);
  }
  throw new Error(
    "authenticated session not established after login (2FA enabled, or account not active?)"
  );
}

function roomLinkSelector(roomId) {
  return `.sidebar-section-link[data-link-name="resenha-room-${roomId}"]`;
}

async function joinRoom(page, bot) {
  const selector = roomLinkSelector(bot.room_id);
  await page.waitForSelector(selector, { timeout: 30000 });

  const state = await connectionState(page, selector);
  if (state !== "connected") {
    await page.click(selector);
  }

  // Connected rooms get the active class (see resenha-sidebar.js).
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return el && el.classList.contains("sidebar-section-link--active");
    },
    selector,
    { timeout: 30000 }
  );
}

async function leaveRoom(page, bot) {
  const selector = roomLinkSelector(bot.room_id);
  const el = await page.$(selector);
  if (!el) {
    return;
  }

  await page.click(selector);
  await page.waitForFunction(
    (sel) => {
      const node = document.querySelector(sel);
      return !node || !node.classList.contains("sidebar-section-link--active");
    },
    selector,
    { timeout: 30000 }
  );
}

// Active (non-bot) participant ids in the room, read from the sidebar avatars.
async function participantIds(page, roomId) {
  return page.evaluate((rid) => {
    const prefix = `resenha-participant-${rid}-`;
    return Array.from(
      document.querySelectorAll(
        `.sidebar-section-link[data-link-name^="${prefix}"]`
      )
    )
      .map((el) => parseInt(el.dataset.linkName.slice(prefix.length), 10))
      .filter((n) => Number.isFinite(n));
  }, roomId);
}

// Stay connected up to active_seconds, but return "newcomer" early when a new
// non-bot participant appears — so the bot can recycle and re-offer as the
// offerer (the negotiation direction that works; see README "Join ordering").
async function stayConnected(page, bot, botUserIds) {
  const ignore = new Set([bot.user_id, ...botUserIds]);
  const baseline = new Set(await participantIds(page, bot.room_id));
  const until = Date.now() + bot.active_seconds * 1000;

  while (!shuttingDown && Date.now() < until) {
    await sleep(PARTICIPANT_POLL_MS);
    let current;
    try {
      current = await participantIds(page, bot.room_id);
    } catch {
      continue; // mid-navigation / transient
    }
    const newcomers = current.filter(
      (id) => !baseline.has(id) && !ignore.has(id)
    );
    if (newcomers.length) {
      log(bot.username, `listener ${newcomers.join(",")} joined; recycling to re-offer`);
      return "newcomer";
    }
  }
  return "elapsed";
}

async function connectionState(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) {
      return "missing";
    }
    if (el.classList.contains("sidebar-section-link--active")) {
      return "connected";
    }
    if (el.classList.contains("resenha-sidebar-link--connecting")) {
      return "connecting";
    }
    return "idle";
  }, selector);
}

// One bot: own browser, own fake-mic file. Loops until shutdown; throws on
// failure so the supervisor can relaunch it.
async function runBot(bot, wavPath, botUserIds) {
  const scope = bot.username;

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // Emit raw host-IP ICE candidates instead of mDNS ".local" names. Inside a
      // container there's no mDNS responder, so the obfuscated candidates never
      // resolve and bot<->bot (same network namespace) can't connect directly.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ],
  });
  activeBrowsers.add(browser);

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Surface browser-side detail in the daemon log: warnings/errors and the
    // resenha client's own "[resenha] ..." breadcrumbs (mic, signaling, join).
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error" || type === "warning" || text.includes("[resenha")) {
        log(scope, `page ${type}: ${text}`);
      }
    });
    page.on("pageerror", (error) => log(scope, `page error: ${error.message}`));

    log(scope, "logging in");
    await login(page, bot);

    // Land on the homepage so the resenha sidebar (and its room links) render.
    await page.goto(SITE_URL, { waitUntil: "domcontentloaded" });

    log(scope, `joining room ${bot.room_slug} (id=${bot.room_id})`);

    while (!shuttingDown) {
      await joinRoom(page, bot);
      log(scope, `connected; playing for up to ${bot.active_seconds}s`);
      const reason = await stayConnected(page, bot, botUserIds);

      if (shuttingDown) {
        break;
      }

      await leaveRoom(page, bot);

      // A listener just joined: recycle almost immediately so they hear the bot
      // without waiting out the idle gap. Otherwise use the configured idle.
      const idleMs = reason === "newcomer" ? 1000 : bot.idle_seconds * 1000;
      log(scope, `left; idle for ${Math.round(idleMs / 1000)}s`);
      await sleep(idleMs);
    }
  } finally {
    activeBrowsers.delete(browser);
    await browser.close().catch(() => {});
  }
}

// Keep a bot alive across crashes (login failure, browser death, network blips).
async function superviseBot(bot, botUserIds) {
  const scope = bot.username;

  while (!shuttingDown) {
    try {
      const wavPath = await ensureAudio(bot.audio_url);
      await runBot(bot, wavPath, botUserIds);
    } catch (error) {
      if (shuttingDown) {
        break;
      }
      log(scope, `crashed: ${error.message}; restarting in ${RESTART_BACKOFF_MS}ms`);
      await sleep(RESTART_BACKOFF_MS);
    }
  }
}

// Fetch config, retrying forever with backoff. The site may not be up yet when
// the container boots, and we must not let a transient failure exit the process
// (runit would respawn it instantly with no backoff -> crash loop).
async function fetchConfigWithRetry() {
  while (!shuttingDown) {
    try {
      return await fetchConfig();
    } catch (error) {
      log(
        "orchestrator",
        `config fetch failed: ${error.message}; retrying in ${CONFIG_RETRY_MS}ms`
      );
      await sleep(CONFIG_RETRY_MS);
    }
  }
  return null;
}

async function main() {
  log("orchestrator", `starting against ${SITE_URL}`);

  // Never return on our own for recoverable states (disabled / empty roster /
  // site down). Idle and re-check instead, so runit only ever restarts us for a
  // genuinely fatal crash. Once bots are running, superviseBot loops until
  // shutdown; change the roster then `sv restart resenha-bots` to reload.
  while (!shuttingDown) {
    const config = await fetchConfigWithRetry();
    if (!config) {
      break; // shutting down
    }

    const bots = config.enabled ? config.bots || [] : [];
    if (bots.length === 0) {
      log(
        "orchestrator",
        `no enabled bots; re-checking config in ${CONFIG_RETRY_MS}ms`
      );
      await sleep(CONFIG_RETRY_MS);
      continue;
    }

    log("orchestrator", `supervising ${bots.length} bot(s)`);
    const botUserIds = bots.map((b) => b.user_id);
    await Promise.all(bots.map((bot) => superviseBot(bot, botUserIds)));
  }
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log("orchestrator", `received ${signal}; closing ${activeBrowsers.size} browser(s)`);
  await Promise.all([...activeBrowsers].map((browser) => browser.close().catch(() => {})));
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A stray rejection in one bot's async chain must not terminate the daemon and
// take the other bots down with it. Log and keep going; the per-bot supervise
// loop already handles awaited failures.
process.on("unhandledRejection", (reason) => {
  log("orchestrator", `unhandled rejection: ${reason?.message || reason}`);
});

main().catch((error) => {
  log("orchestrator", `fatal: ${error.message}`);
  process.exit(1);
});
