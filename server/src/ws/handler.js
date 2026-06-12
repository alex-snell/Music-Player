const { v4: uuid } = require('uuid');
const { register, unregister, send, broadcast } = require('./registry');
const sessionManager = require('../session/manager');
const queueManager   = require('../queue/manager');

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS  = 15_000;

function handleConnection(socket, req) {
  const socketId = uuid();
  let heartbeatTimer  = null;
  let lastPongAt      = Date.now();

  // ── Heartbeat ────────────────────────────────────────────────────────────────

  socket.on('pong', () => { lastPongAt = Date.now(); });

  heartbeatTimer = setInterval(() => {
    if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
      socket.terminate();
      return;
    }
    if (socket.readyState === 1) socket.ping();
  }, HEARTBEAT_INTERVAL_MS);

  // ── Messages ─────────────────────────────────────────────────────────────────

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(socket, { type: 'ERROR', payload: { message: 'Invalid JSON' } });
      return;
    }

    try {
      await route(socket, socketId, msg);
    } catch (err) {
      console.error(`[${msg.type}] ${err.message}`);
      send(socket, { type: 'ERROR', payload: { message: err.message } });
    }
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────

  socket.on('close', async () => {
    clearInterval(heartbeatTimer);
    const meta = unregister(socket, socketId);
    if (meta?.sessionId) {
      await sessionManager.handleDisconnect(meta.sessionId, meta.userId);
    }
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
  });
}

// ─── Message router ───────────────────────────────────────────────────────────

async function route(socket, socketId, msg) {
  const { type, payload = {} } = msg;

  switch (type) {

    // ── Session ──────────────────────────────────────────────────────────────

    case 'SESSION_CREATE': {
      const { userId, platform, displayName } = payload;
      assertFields({ userId, platform, displayName });

      const session = await sessionManager.createSession({ userId, platform, displayName });
      register(socket, socketId, session.id, userId);

      send(socket, {
        type:    'SESSION_CREATED',
        payload: { session },
      });
      break;
    }

    case 'SESSION_JOIN': {
      const { sessionId, userId, platform, displayName } = payload;
      assertFields({ sessionId, userId, platform, displayName });

      const { session, presence } = await sessionManager.joinSession({
        sessionId, userId, platform, displayName,
      });

      register(socket, socketId, sessionId, userId);

      // Send joining user the full current state
      const [queue, nowPlaying] = await Promise.all([
        queueManager.getQueue(sessionId),
        queueManager.getNowPlaying(sessionId),
      ]);

      send(socket, {
        type:    'SESSION_JOINED',
        payload: { session, presence, queue, nowPlaying },
      });

      // Notify everyone else
      broadcast(sessionId, {
        type:    'PRESENCE_UPDATED',
        payload: { presence },
      }, socket);

      break;
    }

    case 'SESSION_END': {
      const { sessionId, userId } = payload;
      assertFields({ sessionId, userId });

      const session = await sessionManager.getSession(sessionId);
      if (session.ownerUserId !== userId) throw new Error('Only the owner can end the session');

      await sessionManager.endSession(sessionId);
      break;
    }

    // ── Queue ────────────────────────────────────────────────────────────────

    case 'QUEUE_ADD': {
      const { sessionId, track } = payload;
      assertFields({ sessionId });
      assertFields(track, ['title', 'artist', 'durationMs', 'addedBy']);

      await queueManager.addTrack(sessionId, track);
      break;
    }

    case 'QUEUE_REMOVE': {
      const { sessionId, trackId } = payload;
      assertFields({ sessionId, trackId });

      await queueManager.removeTrack(sessionId, trackId);
      break;
    }

    case 'QUEUE_REORDER': {
      const { sessionId, trackId, afterTrackId } = payload;
      assertFields({ sessionId, trackId });
      // afterTrackId may legitimately be null (move to front)

      await queueManager.reorderTrack(sessionId, trackId, afterTrackId ?? null);
      break;
    }

    // ── Playback ─────────────────────────────────────────────────────────────
    // Host fires TRACK_ENDED when a song finishes on their device.
    // Server advances the queue and broadcasts the next track to all clients.

    case 'TRACK_ENDED': {
      const { sessionId, userId } = payload;
      assertFields({ sessionId, userId });

      const session = await sessionManager.getSession(sessionId);
      if (session.hostUserId !== userId) throw new Error('Only the host can advance the queue');

      await queueManager.advanceQueue(sessionId);
      break;
    }

    default:
      send(socket, { type: 'ERROR', payload: { message: `Unknown message type: ${type}` } });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertFields(obj, fields = Object.keys(obj)) {
  for (const field of fields) {
    if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
      throw new Error(`Missing required field: ${field}`);
    }
  }
}

module.exports = { handleConnection };
