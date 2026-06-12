const redis = require('../redis');

// ─── Scoring ───────────────────────────────────────────────────────────────────

// Normalise a string for fuzzy comparison:
// lowercase, strip feat./remastered/live/deluxe etc., collapse whitespace
function normalise(str = '') {
  return str
    .toLowerCase()
    .replace(/\(.*?(feat|ft|featuring|remaster|remastered|live|deluxe|edition|version).*?\)/gi, '')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Simple character-level similarity (0–1)
function similarity(a, b) {
  a = normalise(a);
  b = normalise(b);
  if (a === b) return 1;
  if (!a || !b) return 0;

  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;

  // Count matching characters via inclusion (cheap approximation)
  let matches = 0;
  const seen = longer.split('');
  for (const ch of shorter) {
    const idx = seen.indexOf(ch);
    if (idx !== -1) {
      matches++;
      seen.splice(idx, 1);
    }
  }

  return matches / longer.length;
}

function matchScore(source, candidate) {
  const titleScore  = similarity(source.title, candidate.title);
  const artistScore = similarity(source.artist, candidate.artist);

  // Duration match — within 5s = full score, penalty beyond that
  const durationDelta = Math.abs(
    Number(source.durationMs) - Number(candidate.durationMs)
  );
  const durationScore = durationDelta < 5000
    ? 1
    : Math.max(0, 1 - (durationDelta - 5000) / 30000);

  // Weighted: title matters most, then artist, duration is a tiebreaker
  return (titleScore * 0.5) + (artistScore * 0.35) + (durationScore * 0.15);
}

// ─── Platform search stubs ─────────────────────────────────────────────────────
// Replace each with real API calls per platform.
// Each must return: [{ id, title, artist, album, durationMs }]

async function searchPlatform(platform, track) {
  const query = `${track.title} ${track.artist}`;

  switch (platform) {
    case 'spotify':
      return searchSpotify(query, track);
    case 'applemusic':
      return searchAppleMusic(query, track);
    case 'youtubemusic':
      return searchYouTubeMusic(query, track);
    case 'tidal':
      return searchTidal(query, track);
    default:
      return [];
  }
}

// Stubs — each returns [] until wired up with real credentials
async function searchSpotify(query)       { return []; }
async function searchAppleMusic(query)    { return []; }
async function searchYouTubeMusic(query)  { return []; }
async function searchTidal(query)         { return []; }

// ─── Resolver ──────────────────────────────────────────────────────────────────

const MATCH_THRESHOLD = 0.75; // anything above this plays
const CACHE_TTL_S     = 86400; // 24 hours

async function resolveTrack(track, targetPlatform) {
  const cacheKey = `resolve:${track.id}:${targetPlatform}`;

  // Check cache
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Search
  const results = await searchPlatform(targetPlatform, track);

  if (!results.length) {
    return cache(cacheKey, { status: 'no_match' });
  }

  // Score and rank
  const scored = results
    .map((r) => ({ ...r, score: matchScore(track, r) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (best.score >= MATCH_THRESHOLD) {
    return cache(cacheKey, { status: 'match', platformId: best.id, score: best.score });
  }

  return cache(cacheKey, { status: 'no_match' });
}

async function cache(key, value) {
  await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_S);
  return value;
}

module.exports = { resolveTrack, matchScore };
