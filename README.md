# resenha-bots

Demo-only orchestrator for **headless voice bots** that join [Resenha](https://github.com/discourse/resenha)
voice rooms and play a looped audio file as their microphone. Built to make a
demo site feel alive: bots connect to a room, "talk" (play a clip on a loop),
leave, and repeat — forever.

> ⚠️ This is demo infrastructure for a single, controlled site. It stores bot
> passwords in a site setting in plaintext. Do not use it on a real community.

## How it works

Resenha is **pure peer-to-peer WebRTC** — media never touches the server. So we
can't inject audio server-side; instead we run real browsers that behave like
real users:

1. **The plugin** (Ruby) holds the bot roster in the `resenha_bots_config` site
   setting, exposes it to the daemon at `GET /resenha-bots/config.json`
   (admin-only), and runs a once-a-minute Sidekiq reconciler that logs when a
   bot is missing from its room.
2. **The orchestrator** (`orchestrator/`, Node + Playwright) runs one headless
   Chromium per bot. Each browser is launched with Chrome's fake audio device
   pointed at a WAV file (`--use-file-for-fake-audio-capture`, which **loops
   automatically**), logs in, and cycles: join → play → leave → pause → repeat.

Because media is peer-to-peer, a bot alone in a room is silent until a human
joins. **Run ≥2 bots per room** so they peer with each other and the room shows
live speaking indicators even before anyone listens.

## Bot configuration

Set `resenha_bots_config` (Admin → Settings → Plugins) to a JSON array:

```json
[
  {
    "username": "voice_bot_1",
    "password": "s3cret-bot-1",
    "room": "watercooler",
    "audio_url": "/uploads/default/original/1X/abc1230000000000000000000000000000000001.wav",
    "active_seconds": 180,
    "idle_seconds": 15
  },
  {
    "username": "voice_bot_2",
    "password": "s3cret-bot-2",
    "room": "watercooler",
    "audio_url": "/uploads/default/original/1X/def4560000000000000000000000000000000002.wav",
    "active_seconds": 120,
    "idle_seconds": 30
  },
  {
    "username": "voice_bot_3",
    "password": "s3cret-bot-3",
    "room": "watercooler",
    "audio_url": "/uploads/default/original/1X/ghi7890000000000000000000000000000000003.wav"
  }
]
```

The three bots above all join `watercooler`, so they peer with each other and the
room stays audibly active. Their staggered `active_seconds` / `idle_seconds` mean
they join and leave at different times rather than in lockstep (bot 3 falls back
to the `resenha_bots_default_*` settings). Point each `audio_url` at a different
uploaded clip so they don't all play the same thing.

- `username` / `password` — a real Discourse user in `resenha_allowed_groups`.
- `room` — a Resenha room **slug** (or numeric id).
- `audio_url` — a **pre-encoded 16-bit PCM WAV** (upload it to the site and use
  its upload URL). Other formats won't play through Chrome's fake mic. Use a
  clip with continuous-ish audio so the bot doesn't trip Resenha's idle/AFK
  auto-disconnect (or raise the `resenha_afk_*` settings).
- `active_seconds` / `idle_seconds` — optional per-bot overrides of the
  `resenha_bots_default_*` settings.

Invalid entries (unknown user/room, bad JSON) are skipped with a logged warning;
the rest still run.

## Connectivity / TURN (read this before going public)

Resenha is pure peer-to-peer with **no SFU/relay of its own** — if a WebRTC ICE
negotiation fails, there is no fallback and the listener just hears silence. The
bots run inside the Docker container, behind the bridge NAT, so they cannot
reliably reach external listeners on STUN alone. **A TURN server is effectively a
prerequisite for a public demo.**

The bots need **no special wiring** to use TURN: they run the real Discourse
client, which builds its ICE config from site settings. Setting these three is
the entire integration —

| Setting | Value |
| --- | --- |
| `resenha_turn_servers` | `turn:turn.example.com:3478` (pipe-separated for multiple; add a `turns:…:443` entry for listeners on restrictive networks) |
| `resenha_turn_username` | the coturn long-term username |
| `resenha_turn_credential` | the coturn long-term password |

⚠️ **Static credentials only.** Resenha passes `username`/`credential` straight
into the browser's `RTCIceServer` — i.e. coturn's **long-term credential**
mechanism (`lt-cred-mech` with a fixed `user=...`). It does **not** compute the
time-limited HMAC tokens used by coturn's `use-auth-secret` (REST) scheme, so if
your coturn is set up that way the bots (and real users) will authenticate-fail
and relay silently. Configure a fixed long-term user that matches the settings
above.

Notes:

- **Bot ↔ bot traffic stays direct** (they share the container's network
  namespace and pair on host candidates), so TURN only ever relays
  bot ↔ external-listener media — relay bandwidth stays low.
- **Container egress:** make sure the container can reach coturn's ports outbound
  (UDP 3478 and/or TLS 443) if you ever restrict egress.
- **Verify the relay path** on first deploy: in a manual browser test set
  `iceTransportPolicy: "relay"` (or temporarily clear `resenha_stun_servers`) to
  force traffic through coturn and confirm audio actually flows before trusting
  the mixed direct/relay path. A "connected but silent" room is the classic
  TURN-misconfig symptom — presence is plain HTTP, so avatars show as joined even
  when no media is getting through.

## Production install (single VPS, Docker)

Chromium is **not** in the Discourse image and its system libraries need root at
**build** time, so installation goes through `app.yml` hooks, not a runtime job.
The mutable bits (browser binary, audio cache) live in `/shared` so they survive
`./launcher rebuild app`.

Add to your container's `app.yml`:

```yaml
hooks:
  after_code:
    - exec:
        cd: $home/plugins/resenha-bots/orchestrator
        cmd:
          # System libraries Chromium needs (root, at build time):
          - "apt-get update && apt-get install -y --no-install-recommends \
             libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
             libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
             libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0"
          # Install deps + browser as the discourse user, into /shared:
          - "mkdir -p /shared/resenha-bots/ms-playwright /shared/resenha-bots/audio"
          - "chown -R discourse:discourse /shared/resenha-bots"
          - "su discourse -c 'cd $home/plugins/resenha-bots/orchestrator && pnpm install --prod'"
          - "su discourse -c 'PLAYWRIGHT_BROWSERS_PATH=/shared/resenha-bots/ms-playwright \
             $home/plugins/resenha-bots/orchestrator/node_modules/.bin/playwright install chromium'"
    - exec:
        # Register the runit-supervised daemon (auto-restarts on crash):
        cmd:
          - "mkdir -p /etc/service/resenha-bots"
          - "cp $home/plugins/resenha-bots/orchestrator/resenha-bots.runit.sample /etc/service/resenha-bots/run"
          - "chmod +x /etc/service/resenha-bots/run"
```

Then, before the first run:

1. Create the bot users and add them to `resenha_allowed_groups`.
2. Upload the WAV clips; copy each upload URL into `resenha_bots_config`.
3. Set `resenha_turn_servers` / `resenha_turn_username` / `resenha_turn_credential`
   (see [Connectivity / TURN](#connectivity--turn-read-this-before-going-public)).
4. Create an **admin API key** (Admin → API) and put it, plus your site URL,
   into `/etc/service/resenha-bots/run` (edit the `.runit.sample` values first,
   or template them).
5. Set `resenha_bots_enabled` to true.

The daemon reads its roster **once at startup**. After changing
`resenha_bots_config`, reload it with:

```bash
sv restart resenha-bots
```

## Local development

```bash
cd plugins/resenha-bots/orchestrator
pnpm install
pnpm exec playwright install chromium

SITE_URL=http://localhost:3000 \
RESENHA_BOTS_API_KEY=... \
RESENHA_BOTS_API_USERNAME=system \
RESENHA_BOTS_HEADLESS=false \
node index.js
```

`RESENHA_BOTS_HEADLESS=false` opens visible browsers so you can watch the bots
join and confirm the speaking indicators light up.

## Supervision (how 3 bots stay up)

There are two layers:

1. **Daemon supervises each bot.** runit launches one process (`node index.js`).
   Inside it, every bot runs as an independent loop (`superviseBot`): join → play
   → leave → repeat, wrapped in try/catch. If one bot's browser crashes, only
   that bot waits `RESENHA_BOTS_RESTART_BACKOFF_MS` (15s) and relaunches — the
   other bots keep playing. Each bot is its own Chromium process; 3 is trivial.
2. **runit supervises the daemon.** If the whole process dies, runit reruns the
   `run` script. runit restarts on *any* exit with no backoff, so the daemon is
   written to **never exit on its own** for recoverable states (site not up yet,
   `resenha_bots_enabled` false, empty roster): it retries config every
   `RESENHA_BOTS_CONFIG_RETRY_MS` (30s) and idles instead. runit only ever
   restarts us for a genuinely fatal crash.

Operate it with `sv` from inside the container:

```bash
sv status resenha-bots     # up/down + uptime
sv restart resenha-bots    # reload after editing resenha_bots_config
sv down resenha-bots       # stop all bots
```

Logs go to the container log (the runit `run` script does `exec 2>&1`).

## Notes & limits

- Each headless Chrome doing WebRTC encode is real, sustained CPU. A few bots
  per room is fine; dozens will strain the box. For a long-running public demo,
  consider moving the `orchestrator/` daemon to a separate host — the plugin
  side is unchanged.
- The reconciler only **observes** (logs). It never spawns browsers; runit and
  the daemon's own supervision loop handle restarts.
