const { v4: uuid } = require('uuid');
const redis = require('../redis');
const { broadcast } = require('../ws/registry');
const { resolveTrack } = require('../platform/resolver');
const { getSession } = require('../session/manager');

// Keys
const queueKey = (sessionId) => `queue:${sessionId}`;
const trackKey = (sessionId, trackId) => `track:${sessionId}:${trackId}`;
const nowPlayingKey = (sessionId) => `nowplaying:${sessionId}`;

// ─── Read ──────────────────────────────────────────────────────────────────────

async function getQueue(sessionId) {
  const trackIds = await redis.lrange(queueKey(sessionId), 0, -1);
  if (!trackIds.length) return [];

  const tracks = await Promise.all(
    trackIds.map(async (id) => {
      const raw = await redis.hgetall(trackKey(sessionId, id));
      return raw && Object.keys(raw).length ? raw : null;
    })
  );

  return tracks.filter(Boolean);
}

async function getNowPlaying(sessionId) {
  const raw = await redis.hgetall(nowPlayingKey(sessionId));
  return raw && Object.keys(raw).length ? raw : null;
}

// ─── Add ───────────────────────────────────────────────────────────────────────

async function addTrack(sessionId, { title, artist, album, durationMs, addedBy, platformIds = {} }) {
  const trackId = uuid();

  const track = {
    id:         trackId,
    title,
    artist,
    album:      album || '',
    durationMs: String(durationMs),
    addedBy,
    addedAt:    String(Date.now()),
    // platformIds: cache of resolved IDs per platform e.g. { spotify: '...', applemusic: '...' }
    platformIds: JSON.stringify(platformIds),
  };

  await redis.hset(trackKey(sessionId, trackId), track);
  await redis.rpush(queueKey(sessionId), trackId);

  broadcast(sessionId, {
    type:    'QUEUE_TRACK_ADDED',
    payload: { track },
  });

  return track;
}

// ─── Remove ────────────────────────────────────────────────────────────────────

async function removeTrack(sessionId, trackId) {
  const nowPlaying = await getNowPlaying(sessionId);
  if (nowPlaying?.id === trackId) {
    throw new Error('Cannot remove the currently playing track');
  }

  await redis.lrem(queueKey(sessionId), 0, trackId);
  await redis.del(trackKey(sessionId, trackId));

  broadcast(sessionId, {
    type:    'QUEUE_TRACK_REMOVED',
    payload: { trackId },
  });
}

// ─── Reorder ───────────────────────────────────────────────────────────────────
// Places trackId immediately after afterTrackId in the queue.
// afterTrackId = null means move to the front (position 0).

async function reorderTrack(sessionId, trackId, afterTrackId) {
  const trackIds = await redis.lrange(queueKey(sessionId), 0, -1);

  const from = trackIds.indexOf(trackId);
  if (from === -1) throw new Error('Track not in queue');

  // Remove from current position
  const reordered = [...trackIds];
  reordered.splice(from, 1);

  // Insert at target position
  if (afterTrackId === null) {
    reordered.unshift(trackId);
  } else {
    const to = reordered.indexOf(afterTrackId);
    if (to === -1) throw new Error('afterTrackId not in queue');
    reordered.splice(to + 1, 0, trackId);
  }

  // Atomically replace the queue list
  const pipeline = redis.pipeline();
  pipeline.del(queueKey(sessionId));
  if (reordered.length) {
    pipeline.rpush(queueKey(sessionId), ...reordered);
  }
  await pipeline.exec();

  broadcast(sessionId, {
    type:    'QUEUE_REORDERED',
    payload: { orderedTrackIds: reordered },
  });
}

// ─── Advance (move to next track) ─────────────────────────────────────────────
// Called when the current song ends (host client fires TRACK_ENDED).
// Resolves the next track against the current host's platform before broadcasting.

async function advanceQueue(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return;

  const nextId = await redis.lindex(queueKey(sessionId), 0);
  if (!nextId) {
    // Queue exhausted
    await redis.del(nowPlayingKey(sessionId));
    broadcast(sessionId, { type: 'QUEUE_EXHAUSTED' });
    return;
  }

  const track = await redis.hgetall(trackKey(sessionId, nextId));
  if (!track) return;

  // Resolve to the current host's platform
  const platformIds = JSON.parse(track.platformIds || '{}');
  const hostPlatform = session.hostPlatform;

  let resolvedId = platformIds[hostPlatform];

  if (!resolvedId) {
    // Not cached — resolve now
    const result = await resolveTrack(track, hostPlatform);

    if (result.status === 'no_match') {
      // Try each other connected platform before skipping
      const { getPresence } = require('../session/manager');
      const presence = await getPresence(sessionId);
      const others = presence.filter((p) => p.userId !== session.hostUserId);

      let fallback = null;
      for (const guest of others) {
        const attempt = await resolveTrack(track, guest.platform);
        if (attempt.status !== 'no_match') {
          fallback = { platformId: attempt.platformId, platform: guest.platform };
          break;
        }
      }

      if (!fallback) {
        // Truly unresolvable — skip and try the next one
        await redis.lrem(queueKey(sessionId), 1, nextId);
        broadcast(sessionId, {
          type:    'TRACK_SKIPPED',
          payload: { trackId: nextId, reason: 'unresolvable' },
        });
        await advanceQueue(sessionId); // recurse to next track
        return;
      }

      resolvedId = fallback.platformId;
    } else {
      resolvedId = result.platformId;
    }

    // Cache it for next time
    platformIds[hostPlatform] = resolvedId;
    await redis.hset(trackKey(sessionId, nextId), 'platformIds', JSON.stringify(platformIds));
  }

  // Pop from queue, set as now playing
  await redis.lrem(queueKey(sessionId), 1, nextId);
  await redis.hset(nowPlayingKey(sessionId), {
    ...track,
    platformId:   resolvedId,
    startedAt:    String(Date.now()),
  });

  broadcast(sessionId, {
    type:    'TRACK_STARTED',
    payload: {
      track: { ...track, platformId: resolvedId },
      startedAt: Date.now(),
    },
  });
}

module.exports = {
  getQueue,
  getNowPlaying,
  addTrack,
  removeTrack,
  reorderTrack,
  advanceQueue,
};
