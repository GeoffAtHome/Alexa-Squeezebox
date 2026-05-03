/**
 * lmsClient.ts
 *
 * Typed HTTP client for the AlexaBridge LMS plugin REST API.
 *
 * All methods return parsed JSON.  stream_url and artwork_url fields returned
 * by the plugin are relative paths; this client prepends LMS_BASE_URL so
 * callers always receive fully-qualified URLs ready for Alexa directives.
 *
 * Required environment variables:
 *   LMS_BASE_URL      – e.g. https://lms.yourdomain.com  (no trailing slash)
 *   LMS_API_TOKEN     – computed API token from plugin settings page
 *   LMS_PLAYER_ID     – target LMS player ID (from /alexa/players)
 * Optional environment variables:
 *   LMS_BASIC_AUTH_USER  – HTTP Basic auth username for LMS/reverse proxy
 *   LMS_BASIC_AUTH_PASS  – HTTP Basic auth password for LMS/reverse proxy
 */

import fetch from "node-fetch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LmsTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  tracknum: number | null;
  duration: number | null;
  /** Fully-qualified signed stream URL – pass directly to Alexa AudioPlayer */
  stream_url: string;
  /** Fully-qualified artwork URL – pass to Echo Show APL image */
  artwork_url: string;
}

export interface LmsAlbum {
  id: number;
  title: string;
  artist: string;
  year: number | null;
}

export interface LmsArtist {
  id: number;
  name: string;
}

export type SearchType = "track" | "album" | "artist";

export interface SearchResults {
  results: (LmsTrack | LmsAlbum | LmsArtist)[];
}

export interface AlbumTracksResult {
  album: LmsAlbum;
  tracks: LmsTrack[];
}

export interface NowPlayingResult {
  player_id: string;
  name: string;
  is_playing: boolean;
  volume: number;
  track: LmsTrack | null;
}

export interface Player {
  id: string;
  name: string;
  model: string;
  connected: boolean;
}

export type ControlCommand =
  | "pause"
  | "resume"
  | "next"
  | "prev"
  | "volume"
  | "stop";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getConfig() {
  const base = process.env.LMS_BASE_URL;
  const token = process.env.LMS_API_TOKEN;
  const playerId = process.env.LMS_PLAYER_ID;
  const basicAuthUser = process.env.LMS_BASIC_AUTH_USER;
  const basicAuthPass = process.env.LMS_BASIC_AUTH_PASS;

  if (!base) throw new Error("Missing env var: LMS_BASE_URL");
  if (!token) throw new Error("Missing env var: LMS_API_TOKEN");
  if (!playerId) throw new Error("Missing env var: LMS_PLAYER_ID");

  const parsed = new URL(base);
  const embeddedUser = parsed.username
    ? decodeURIComponent(parsed.username)
    : undefined;
  const embeddedPass = parsed.password
    ? decodeURIComponent(parsed.password)
    : "";

  // Strip credentials from outgoing URL once extracted.
  parsed.username = "";
  parsed.password = "";

  // Optional separate base URL for stream/artwork URLs (e.g. DNS-only hostname
  // for audio streaming, bypassing Cloudflare proxy restrictions on media).
  const streamBase =
    (process.env.LMS_STREAM_BASE_URL ?? "").replace(/\/$/, "") ||
    parsed.toString().replace(/\/$/, "");

  return {
    base: parsed.toString().replace(/\/$/, ""),
    streamBase,
    token,
    playerId,
    basicAuthUser: basicAuthUser ?? embeddedUser,
    basicAuthPass: basicAuthPass ?? embeddedPass,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function apiGet<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const { base, token, basicAuthUser, basicAuthPass } = getConfig();
  const qs = new URLSearchParams({ ...params, token });
  const url = `${base}${path}?${qs}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (basicAuthUser !== undefined && basicAuthPass !== undefined) {
    const basic = Buffer.from(
      `${basicAuthUser}:${basicAuthPass}`,
      "utf8",
    ).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }

  const res = await fetch(url, {
    headers,
    // node-fetch follows redirects by default (needed for /alexa/stream)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LMS API error ${res.status} on ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

/** Prepend base URLs to relative paths returned by the plugin.
 *  stream_url and artwork_url use LMS_STREAM_BASE_URL when set, so that audio
 *  streaming can bypass the Cloudflare proxy (DNS only) while API calls still
 *  reach LMS via a separate proxied hostname. */
function qualify(track: LmsTrack): LmsTrack {
  const { base, streamBase } = getConfig();
  return {
    ...track,
    stream_url: track.stream_url.startsWith("http")
      ? track.stream_url
      : `${streamBase}${track.stream_url}`,
    artwork_url: track.artwork_url.startsWith("http")
      ? track.artwork_url
      : `${base}${track.artwork_url}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Search the LMS library for tracks, albums, or artists */
export async function search(
  q: string,
  type: SearchType = "track",
): Promise<SearchResults> {
  const result = await apiGet<SearchResults>("/alexa/search", { q, type });
  if (type === "track") {
    result.results = (result.results as LmsTrack[]).map(qualify);
  }
  return result;
}

/** Get all tracks in an album, in track-number order */
export async function albumTracks(albumId: number): Promise<AlbumTracksResult> {
  const result = await apiGet<AlbumTracksResult>(
    `/alexa/album/${albumId}/tracks`,
  );
  result.tracks = result.tracks.map(qualify);
  return result;
}

/** Get a single track by its LMS database ID */
export async function getTrack(trackId: number): Promise<LmsTrack> {
  const result = await apiGet<LmsTrack>(`/alexa/track/${trackId}`);
  return qualify(result);
}

/** Get the current now-playing state for the configured player */
export async function nowPlaying(): Promise<NowPlayingResult> {
  const { playerId } = getConfig();
  const result = await apiGet<NowPlayingResult>("/alexa/nowplaying", {
    player: playerId,
  });
  if (result.track) result.track = qualify(result.track);
  return result;
}

/** Send a playback command to the configured player */
export async function control(
  cmd: ControlCommand,
  value?: number,
): Promise<void> {
  const { playerId } = getConfig();
  const params: Record<string, string> = { player: playerId, cmd };
  if (value !== undefined) params.value = String(value);
  await apiGet("/alexa/control", params);
}

/** List all LMS players – use this to discover LMS_PLAYER_ID */
export async function listPlayers(): Promise<Player[]> {
  const result = await apiGet<{ players: Player[] }>("/alexa/players");
  return result.players;
}

// ---------------------------------------------------------------------------
// Shadow state reporting
// ---------------------------------------------------------------------------

export type PlaybackState = "playing" | "paused" | "stopped";

/**
 * Report the current Alexa AudioPlayer state back to LMS so LMS can shadow
 * what Alexa is playing.  Errors are swallowed – this is best-effort.
 */
export async function reportPlayback(
  state: PlaybackState,
  trackId?: number,
  offsetMs?: number,
): Promise<void> {
  const params: Record<string, string> = { state };
  if (trackId !== undefined) params.trackId = String(trackId);
  if (offsetMs !== undefined) params.offsetMs = String(offsetMs);
  try {
    await apiGet("/alexa/playback", params);
  } catch (err) {
    // Non-fatal – don't let a reporting failure break playback
    console.warn("reportPlayback failed:", (err as Error).message);
  }
}
