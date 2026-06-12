// Maps sessionId → Set of WebSocket connections
// Maps socketId → { sessionId, userId }
const sessions = new Map();
const socketMeta = new Map();

function register(socket, socketId, sessionId, userId) {
  socketMeta.set(socketId, { sessionId, userId });

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, new Set());
  }
  sessions.get(sessionId).add(socket);
}

function unregister(socket, socketId) {
  const meta = socketMeta.get(socketId);
  if (!meta) return null;

  const { sessionId } = meta;
  const room = sessions.get(sessionId);
  if (room) {
    room.delete(socket);
    if (room.size === 0) sessions.delete(sessionId);
  }

  socketMeta.delete(socketId);
  return meta; // caller needs { sessionId, userId } to run disconnect logic
}

function broadcast(sessionId, message, excludeSocket = null) {
  const room = sessions.get(sessionId);
  if (!room) return;

  const payload = JSON.stringify(message);
  for (const socket of room) {
    if (socket !== excludeSocket && socket.readyState === 1 /* OPEN */) {
      socket.send(payload);
    }
  }
}

function send(socket, message) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

module.exports = { register, unregister, broadcast, send };
