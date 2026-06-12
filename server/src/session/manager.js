const { v4: uuid } = require('uuid');
const redis = require('../redis');
const { broadcast, getSocket } = require('../ws/registry');

const GRACE_MS = 5_000;
const ZOMBIE_TIMEOUT_MS = 10 * 60 * 1000;

// Key helpers
const sessionKey  = (id) => `session:${id}`;
const presenceKey = (id) => `presence:${id}`;

// ─── Create ───────────────────────────────────────────────────────────────────

async function createSession({ userId, platform, displayName }) {
  const sessionId = uuid();
  const now = Date.now();

  const session = {
    id:           sessionId,
    ownerUserId:  userId,   // permanent — always reclaims on rejoin
    hostUserId:   userId,   // current driver
    hostPlatform: platform,
    state:        'idle',
    createdAt:    now,
    hostGoneAt:   '',
  };

  await redis.hset(sessionKey(sessionId), session);

  await addPresence(sessionId, { userId, platform, displayName });

  return session;
}

// ─── Join ─────────────────────────────────────────────────────────────────────

async function joinSession({ sessionId, userId, platform, displayName }) {
  const session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');
  if (session.state === 'ended') throw new Error('Session has ended');

  // Owner rejoining — reclaim host immediately
  if (userId === session.ownerUserId && userId !== session.hostUserId) {
    await reclaimHost(sessionId, userId, platform);
  }

  await addPresence(sessionId, { userId, platform, displayName });

  // Flip idle → active when first guest joins
  if (session.state === 'idle' && userId !== session.ownerUserId) {
    await redis.hset(sessionKey(sessionId), 'state', 'active');
    broadcast(sessionId, { type: 'SESSION_ACTIVE' });
  }

  const updatedSession = await getSession(sessionId);
  const presence = await getPresence(sessionId);

  return { session: updatedSession, presence };
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

async function handleDisconnect(sessionId, userId) {
  await removePresence(sessionId, userId);

  const session = await getSession(sessionId);
  if (!session || session.state === 'ended') return;

  const presence = await getPresence(sessionId);

  // Everyone left — end the session
  if (presence.length === 0) {
    await endSession(sessionId);
    return;
  }

  // Host disconnected
  if (userId === session.hostUserId) {
    // If owner left but there are still guests, start grace + migration
    const hostGoneAt = Date.now();
    await redis.hset(sessionKey(sessionId), {
      state:       'host_gone',
      hostGoneAt:  hostGoneAt,
    });

    broadcast(sessionId, {
      type:    'HOST_GONE',
      payload: { gracePeriodMs: GRACE_MS },
    });

    // Schedule migration after grace period
    setTimeout(() => migrateHost(sessionId, hostGoneAt), GRACE_MS);
    return;
  }

  // A guest left — check for zombie (only owner remains)
  if (presence.length === 1 && presence[0].userId === session.ownerUserId) {
    await redis.hset(sessionKey(sessionId), 'state', 'zombie');
    broadcast(sessionId, { type: 'SESSION_ZOMBIE' });
    setTimeout(() => maybeEndZombie(sessionId), ZOMBIE_TIMEOUT_MS);
    return;
  }

  // Regular guest departure — just notify
  broadcast(sessionId, {
    type:    'PRESENCE_UPDATED',
    payload: { presence },
  });
}

// ─── Host migration ───────────────────────────────────────────────────────────

async function migrateHost(sessionId, hostGoneAt) {
  const session = await getSession(sessionId);
  if (!session) return;

  // Owner rejoined during grace period — no migration needed
  if (session.state !== 'host_gone') return;

  // Grace period stamp mismatch — a newer disconnect superseded this one
  if (String(session.hostGoneAt) !== String(hostGoneAt)) return;

  const presence = await getPresence(sessionId);
  if (presence.length === 0) {
    await endSession(sessionId);
    return;
  }

  // Pick longest-connected guest (excluding the gone host)
  const candidates = presence.filter((p) => p.userId !== session.hostUserId);
  if (candidates.length === 0) {
    await endSession(sessionId);
    return;
  }

  const newHost = candidates[0]; // presence list is ordered by join time

  await redis.hset(sessionKey(sessionId), {
    hostUserId:   newHost.userId,
    hostPlatform: newHost.platform,
    state:        'active',
    hostGoneAt:   '',
  });

  broadcast(sessionId, {
    type:    'HOST_MIGRATED',
    payload: {
      newHostUserId:   newHost.userId,
      newHostPlatform: newHost.platform,
    },
  });
}

// ─── Owner reclaim ────────────────────────────────────────────────────────────

async function reclaimHost(sessionId, userId, platform) {
  const session = await getSession(sessionId);
  if (!session) return;

  const previousHostId = session.hostUserId;

  await redis.hset(sessionKey(sessionId), {
    hostUserId:   userId,
    hostPlatform: platform,
    state:        'active',
    hostGoneAt:   '',
  });

  broadcast(sessionId, {
    type:    'HOST_RECLAIMED',
    payload: {
      hostUserId:      userId,
      hostPlatform:    platform,
      previousHostId,
    },
  });
}

// ─── End session ──────────────────────────────────────────────────────────────

async function endSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session || session.state === 'ended') return;

  await redis.hset(sessionKey(sessionId), 'state', 'ended');

  // TODO: flush op log + final queue snapshot to Postgres

  // Clear live state from Redis after a short delay
  // (delay lets any in-flight reads complete gracefully)
  setTimeout(async () => {
    await redis.del(sessionKey(sessionId));
    await redis.del(presenceKey(sessionId));
  }, 5_000);

  broadcast(sessionId, { type: 'SESSION_ENDED' });
}

async function maybeEndZombie(sessionId) {
  const session = await getSession(sessionId);
  if (session?.state === 'zombie') {
    await endSession(sessionId);
  }
}

// ─── Presence helpers ─────────────────────────────────────────────────────────

async function addPresence(sessionId, { userId, platform, displayName }) {
  // Presence is a JSON array stored as a single Redis string.
  // Small sessions (< ~20 people) — this is fine.
  const existing = await getPresence(sessionId);
  const filtered = existing.filter((p) => p.userId !== userId);
  filtered.push({ userId, platform, displayName, joinedAt: Date.now() });
  await redis.set(presenceKey(sessionId), JSON.stringify(filtered));
}

async function removePresence(sessionId, userId) {
  const existing = await getPresence(sessionId);
  const updated = existing.filter((p) => p.userId !== userId);
  await redis.set(presenceKey(sessionId), JSON.stringify(updated));
}

async function getPresence(sessionId) {
  const raw = await redis.get(presenceKey(sessionId));
  return raw ? JSON.parse(raw) : [];
}

// ─── Getters ──────────────────────────────────────────────────────────────────

async function getSession(sessionId) {
  const data = await redis.hgetall(sessionKey(sessionId));
  return data && Object.keys(data).length ? data : null;
}

module.exports = {
  createSession,
  joinSession,
  handleDisconnect,
  endSession,
  getSession,
  getPresence,
};
