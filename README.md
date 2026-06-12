# Music Player name TBD

Listen to music together across any platform. Spotify, Apple Music, YouTube Music, and Tidal users can share a queue and stay in sync in real time — no one needs to switch apps.

---

## How it works

One person creates a session and becomes the **host**. Their platform drives playback. Everyone else joins with a room code and listens from their own app. The queue is shared — anyone can add tracks, remove them, or drag to reorder. When a track plays, the server resolves it against each platform so everyone hears the same song regardless of where their library lives.

When the host disconnects, a 5-second grace period runs. If they don't come back, the longest-connected guest is promoted. If the original host rejoins at any point, they reclaim host automatically. The current song always plays out in full through any handoff.

---

## Stack

- **Node.js** — WebSocket server (`ws`)
- **Redis** — live session state, queue, presence, resolution cache
- **Postgres** — session history and op log (persistence layer)

---

## Getting started

### Prerequisites

- Node.js 18+
- Redis running locally (or a Redis URL)
- Postgres database


PORT=3000
REDIS_HOST=localhost
REDIS_PORT=6379
DATABASE_URL=postgres://user:password@localhost:5432/tunesync

SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
APPLE_MUSIC_KEY_ID=
APPLE_MUSIC_TEAM_ID=
APPLE_MUSIC_PRIVATE_KEY_PATH=
TIDAL_CLIENT_ID=
TIDAL_CLIENT_SECRET=
```

### Run

```bash
node src/index.js
```

The server starts on `PORT` (default `3000`) with a `/health` endpoint for uptime checks.

---

## Project structure

```
server/
├── src/
│   ├── index.js              # HTTP + WebSocket server entry point
│   ├── redis.js              # Redis client singleton
│   ├── session/
│   │   └── manager.js        # Create, join, disconnect, migrate, reclaim
│   ├── queue/
│   │   └── manager.js        # Add, remove, reorder, advance
│   ├── platform/
│   │   └── resolver.js       # Cross-platform track matching and scoring
│   └── ws/
│       ├── handler.js        # Message routing, heartbeat
│       └── registry.js       # Socket → session mapping, broadcast
```

---

## WebSocket API

All messages are JSON. Send `{ type, payload }`. Receive `{ type, payload }`.

### Session

#### `SESSION_CREATE`
Create a new session. The sender becomes the host and owner.

```json
{
  "type": "SESSION_CREATE",
  "payload": {
    "userId": "user_abc",
    "platform": "spotify",
    "displayName": "Jamie"
  }
}
```

Response: `SESSION_CREATED` with the full session object and a `session.id` to share as the room code.

---

#### `SESSION_JOIN`
Join an existing session.

```json
{
  "type": "SESSION_JOIN",
  "payload": {
    "sessionId": "...",
    "userId": "user_xyz",
    "platform": "applemusic",
    "displayName": "Rosa"
  }
}
```

Response to sender: `SESSION_JOINED` with `{ session, presence, queue, nowPlaying }` — everything needed to render the full UI state.

Broadcast to room: `PRESENCE_UPDATED` with updated presence list.

---

#### `SESSION_END`
End the session. Owner only.

```json
{
  "type": "SESSION_END",
  "payload": {
    "sessionId": "...",
    "userId": "user_abc"
  }
}
```

Broadcast to room: `SESSION_ENDED`.

---

### Queue

#### `QUEUE_ADD`

```json
{
  "type": "QUEUE_ADD",
  "payload": {
    "sessionId": "...",
    "track": {
      "title": "Redbone",
      "artist": "Childish Gambino",
      "album": "Awaken, My Love!",
      "durationMs": 257000,
      "addedBy": "user_xyz",
      "platformIds": { "spotify": "3kxfsdsCpFgN412fpnW85Y" }
    }
  }
}
```

Broadcast to room: `QUEUE_TRACK_ADDED` with the full track object including server-assigned `id`.

---

#### `QUEUE_REMOVE`

```json
{
  "type": "QUEUE_REMOVE",
  "payload": {
    "sessionId": "...",
    "trackId": "..."
  }
}
```

The currently playing track cannot be removed. Broadcast to room: `QUEUE_TRACK_REMOVED`.

---

#### `QUEUE_REORDER`
Move a track to a new position. `afterTrackId: null` moves it to the front.

```json
{
  "type": "QUEUE_REORDER",
  "payload": {
    "sessionId": "...",
    "trackId": "...",
    "afterTrackId": "..." 
  }
}
```

Broadcast to room: `QUEUE_REORDERED` with `{ orderedTrackIds }` — the full new order as an array of IDs.

---

### Playback

#### `TRACK_ENDED`
Host fires this when a song finishes on their device. The server resolves the next track against the current host's platform and broadcasts `TRACK_STARTED` to all clients.

```json
{
  "type": "TRACK_ENDED",
  "payload": {
    "sessionId": "...",
    "userId": "user_abc"
  }
}
```

---

### Server-initiated events

These are broadcast by the server — clients never send them.

| Type | When | Payload |
|---|---|---|
| `SESSION_ACTIVE` | First guest joins | — |
| `SESSION_ENDED` | Session ends for any reason | — |
| `SESSION_ZOMBIE` | All guests leave, host remains | — |
| `PRESENCE_UPDATED` | Anyone joins or leaves | `{ presence }` |
| `HOST_GONE` | Host disconnects | `{ gracePeriodMs }` |
| `HOST_MIGRATED` | Grace period expired, new host promoted | `{ newHostUserId, newHostPlatform }` |
| `HOST_RECLAIMED` | Original owner rejoined | `{ hostUserId, hostPlatform, previousHostId }` |
| `TRACK_STARTED` | Next track resolved and ready | `{ track, startedAt }` |
| `TRACK_SKIPPED` | Track unresolvable on all platforms | `{ trackId, reason }` |
| `QUEUE_EXHAUSTED` | Queue emptied | — |

---

## Session lifecycle

```
idle ──(guest joins)──► active ──(host disconnects)──► host_gone
                          │                                  │
                          │                           5s grace period
                          │                                  │
                          │◄──(owner rejoins, any time)──────┤
                          │                                  │
                          │◄──(migrated to new host)─────────┘
                          │
                    (all guests leave)
                          │
                        zombie ──(10 min idle)──► ended
                          │
                    (host ends / timeout)
                          │
                        ended
```

**Owner vs host** — `ownerUserId` is permanent (session creator). `hostUserId` is whoever is currently driving. If the owner disconnects and a guest is promoted, the owner reclaims host the moment they reconnect — no action needed.

---

## Track resolution

When the host platform changes (migration or owner reclaim), the server resolves queued tracks against the new platform before playback. Resolution is scored on title similarity, artist similarity, and duration match. Anything above a 0.75 score plays. If a track can't be resolved on the host's platform, the server tries each other connected guest's platform as a fallback. If every platform fails, the track is skipped and the room is notified.

Resolved platform IDs are cached in Redis for 24 hours so the same track is never looked up twice in a session.

To add a platform, implement the relevant search stub in `src/platform/resolver.js`:

```js
async function searchSpotify(query, track)      { /* return [{ id, title, artist, album, durationMs }] */ }
async function searchAppleMusic(query, track)   { /* ... */ }
async function searchYouTubeMusic(query, track) { /* ... */ }
async function searchTidal(query, track)        { /* ... */ }
```

---

## Supported platforms

| Platform | Status |
|---|---|
| Spotify | Stub — needs client credentials |
| Apple Music | Stub — needs MusicKit key |
| YouTube Music | Stub — needs YouTube Data API key |
| Tidal | Stub — needs client credentials |

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: 3000) |
| `REDIS_HOST` | Yes | Redis hostname |
| `REDIS_PORT` | No | Redis port (default: 6379) |
| `DATABASE_URL` | Yes | Postgres connection string |
| `SPOTIFY_CLIENT_ID` | For Spotify | Spotify app client ID |
| `SPOTIFY_CLIENT_SECRET` | For Spotify | Spotify app client secret |
| `APPLE_MUSIC_KEY_ID` | For Apple Music | MusicKit key ID |
| `APPLE_MUSIC_TEAM_ID` | For Apple Music | Apple developer team ID |
| `APPLE_MUSIC_PRIVATE_KEY_PATH` | For Apple Music | Path to `.p8` key file |
| `TIDAL_CLIENT_ID` | For Tidal | Tidal app client ID |
| `TIDAL_CLIENT_SECRET` | For Tidal | Tidal app client secret |

---

## Roadmap

- [ ] Wire up platform search functions (Spotify first)
- [ ] Postgres op log flush on session end
- [ ] REST endpoints for session state (for clients that can't hold a WebSocket open)
- [ ] Client SDK (TypeScript)
- [ ] Web client
- [ ] iOS / Android apps