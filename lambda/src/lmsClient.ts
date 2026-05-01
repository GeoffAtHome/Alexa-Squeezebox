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

  if (!base) throw new Error("Missing env var: LMS_BASE_URL");
  if (!token) throw new Error("Missing env var: LMS_API_TOKEN");
  if (!playerId) throw new Error("Missing env var: LMS_PLAYER_ID");

  return { base: base.replace(/\/$/, ""), token, playerId };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function apiGet<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const { base, token } = getConfig();
  const qs = new URLSearchParams({ ...params, token });
  const url = `${base}${path}?${qs}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    // node-fetch follows redirects by default (needed for /alexa/stream)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LMS API error ${res.status} on ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

/** Prepend LMS_BASE_URL to relative paths returned by the plugin */
function qualify(track: LmsTrack): LmsTrack {
  const { base } = getConfig();
  return {
    ...track,
    stream_url: track.stream_url.startsWith("http")
      ? track.stream_url
      : `${base}${track.stream_url}`,
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
