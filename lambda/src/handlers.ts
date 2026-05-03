/**
 * handlers.ts
 *
 * ASK SDK v2 request handlers for the Alexa-Squeezebox skill.
 *
 * UK notes:
 *   - AMAZON.PlayMusicIntent and music-domain built-ins are US-only.
 *     All music intents here are CUSTOM with AMAZON.SearchQuery slots.
 *   - AMAZON.MusicAlbum / AMAZON.MusicArtist built-in slots are not
 *     available in en-GB — SearchQuery is used throughout.
 *   - AMAZON.PauseIntent, AMAZON.ResumeIntent, AMAZON.NextIntent,
 *     AMAZON.PreviousIntent, AMAZON.StopIntent ARE available in en-GB.
 *   - AudioPlayer interface is fully supported in the UK.
 *   - APL is supported on Echo Show devices in the UK.
 *   - However, Alexa doesn't allow APL RenderDocument in the same response as
 *     AudioPlayer directives, so playback responses must rely on AudioPlayer
 *     metadata and native transport controls instead of custom APL buttons.
 */

import {
  HandlerInput,
  RequestHandler,
  ErrorHandler as IErrorHandler,
} from "ask-sdk-core";
import { Response, interfaces } from "ask-sdk-model";
import * as lms from "./lmsClient";
import { buildNowPlayingApl, NowPlayingAplMeta } from "./aplBuilder";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function supportsApl(handlerInput: HandlerInput): boolean {
  const interfaces =
    handlerInput.requestEnvelope.context?.System?.device?.supportedInterfaces;
  return !!interfaces?.["Alexa.Presentation.APL"];
}

function supportsAudio(handlerInput: HandlerInput): boolean {
  const ifaces =
    handlerInput.requestEnvelope.context?.System?.device?.supportedInterfaces;
  return !!ifaces?.AudioPlayer;
}

function getSlotValue(
  handlerInput: HandlerInput,
  slotName: string,
): string | undefined {
  const intent = (handlerInput.requestEnvelope.request as any).intent;
  return intent?.slots?.[slotName]?.value;
}

function audioPlayerState(
  handlerInput: HandlerInput,
): interfaces.audioplayer.AudioPlayerState | undefined {
  return handlerInput.requestEnvelope.context?.AudioPlayer as
    | interfaces.audioplayer.AudioPlayerState
    | undefined;
}

function requestType(handlerInput: HandlerInput): string {
  return (handlerInput.requestEnvelope.request as any).type as string;
}

function isPlaybackControllerRequest(handlerInput: HandlerInput): boolean {
  return requestType(handlerInput).startsWith("PlaybackController.");
}

interface QueueState {
  queue: number[];
  index: number;
}

function encodeQueueState(queue: number[], index: number): string {
  return Buffer.from(JSON.stringify({ queue, index }), "utf8").toString(
    "base64url",
  );
}

function decodeQueueState(token?: string): QueueState | undefined {
  if (!token) return undefined;

  // Backward compatibility for old tokens that were plain track IDs.
  if (/^\d+$/.test(token)) {
    const id = parseInt(token, 10);
    return Number.isNaN(id) ? undefined : { queue: [id], index: 0 };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    ) as Partial<QueueState>;
    if (!Array.isArray(parsed.queue)) return undefined;
    const queue = parsed.queue
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0);
    if (!queue.length) return undefined;
    const index = Number(parsed.index);
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
      return undefined;
    }
    return { queue, index };
  } catch {
    return undefined;
  }
}

function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function buildNowPlayingAplMeta(
  track: lms.LmsTrack,
  state?: QueueState,
  offsetMs = 0,
): NowPlayingAplMeta {
  const durationMs = Math.max(0, Math.floor((track.duration ?? 0) * 1000));
  const elapsedMs = Math.max(0, Math.floor(offsetMs));
  const clampedElapsedMs = durationMs
    ? Math.min(elapsedMs, durationMs)
    : elapsedMs;

  const progressPercent = durationMs
    ? Math.min(100, Math.max(0, (clampedElapsedMs / durationMs) * 100))
    : 0;

  const trackPositionLabel = state
    ? `Track ${state.index + 1} of ${state.queue.length}`
    : track.tracknum
      ? `Track ${track.tracknum}`
      : "";

  return {
    elapsedLabel: formatDuration(clampedElapsedMs / 1000),
    durationLabel: durationMs ? formatDuration(durationMs / 1000) : "--:--",
    progressWidth: `${Math.round(progressPercent)}%`,
    showProgress: durationMs > 0,
    trackPositionLabel,
    autoRefresh: durationMs > 0,
  };
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/**
 * Parse a free-text play query into title + optional artist.
 *
 * Recognised patterns:
 *   "Title by Artist"       → { title: "Title", artist: "Artist" }
 *   "Artist's Title"        → { title: "Title", artist: "Artist" }
 *   "Artist's Title"        → same (smart apostrophe)
 *   anything else           → { title: rawQuery }
 */
function parseQuery(raw: string): { title: string; artist?: string } {
  // "Title by Artist"  (e.g. "Dark Side of the Moon by Pink Floyd")
  const byMatch = /^(.+?)\s+by\s+([^,]+?)\s*$/i.exec(raw);
  if (byMatch) return { title: byMatch[1].trim(), artist: byMatch[2].trim() };

  // "Artist's Title" or "Artist's Title" (straight or curly apostrophe)
  const possMatch = /^(.+?)[\u2019']s\s+(.+)$/i.exec(raw);
  if (possMatch)
    return { title: possMatch[2].trim(), artist: possMatch[1].trim() };

  return { title: raw };
}

function artistMatches(candidate: string, query: string): boolean {
  const a = candidate.toLowerCase();
  const b = query.toLowerCase();
  return a.includes(b) || b.includes(a);
}

function speechForLmsError(err: unknown): string {
  const message = (err as Error)?.message ?? "";
  if (message.includes("LMS API error 401")) {
    return "I can't reach your music server because authentication failed. Please check the LMS password settings and Lambda basic-auth environment variables.";
  }
  if (message.includes("LMS API error 403")) {
    return "I can't reach your music server because access was denied. Please check your API token and LMS plugin secret.";
  }
  return "Sorry, I couldn't reach the music server. Please try again in a moment.";
}

interface PlayResolution {
  tracks: lms.LmsTrack[];
  speech: string;
}

/**
 * Resolve a free-text play query to an ordered list of tracks.
 *
 * Strategy:
 *   1. Parse "Title by Artist" / "Artist's Title" patterns.
 *   2. Search albums matching the title; pick one matching the artist if given.
 *   3. If a matching album is found, return its full track list.
 *   4. Otherwise fall back to track search, optionally filtered by artist.
 */
async function resolvePlayQuery(rawQuery: string): Promise<PlayResolution> {
  const { title, artist } = parseQuery(rawQuery);

  // --- Album search first ---
  try {
    const { results: albumResults } = await lms.search(title, "album");
    const albums = albumResults as lms.LmsAlbum[];

    // Prefer artist-matching album; fall back to first result
    const album = artist
      ? (albums.find((a) => artistMatches(a.artist, artist)) ?? albums[0])
      : albums[0];

    if (album) {
      const { tracks } = await lms.albumTracks(album.id);
      if (tracks.length) {
        return {
          tracks,
          speech: `Playing ${album.title} by ${album.artist}.`,
        };
      }
    }
  } catch {
    /* fall through to track search */
  }

  // --- Track search fallback ---
  // Include artist in query string to improve relevance
  const trackQuery = artist ? `${title} ${artist}` : title;
  const { results } = await lms.search(trackQuery, "track");
  let tracks = results as lms.LmsTrack[];

  if (artist && tracks.length) {
    const filtered = tracks.filter((t) => artistMatches(t.artist, artist));
    if (filtered.length) tracks = filtered;
  }

  return {
    tracks,
    speech: tracks.length
      ? `Playing ${tracks[0].title} by ${tracks[0].artist}.`
      : "",
  };
}

/** Build an AudioPlayer.Play directive for a single track */
function playDirective(
  track: lms.LmsTrack,
  behaviour: "REPLACE_ALL" | "ENQUEUE" | "REPLACE_ENQUEUED",
  previousToken?: string,
  token?: string,
): interfaces.audioplayer.PlayDirective {
  return {
    type: "AudioPlayer.Play",
    playBehavior: behaviour,
    audioItem: {
      stream: {
        url: track.stream_url,
        token: token ?? String(track.id),
        expectedPreviousToken:
          behaviour === "ENQUEUE" ? previousToken : undefined,
        offsetInMilliseconds: 0,
      },
      metadata: {
        title: track.title,
        subtitle: `${track.artist} · ${track.album}`,
        art: {
          sources: [{ url: track.artwork_url }],
        },
        backgroundImage: {
          sources: [{ url: track.artwork_url }],
        },
      },
    },
  };
}

/**
 * Exported for unit testing only.
 * @internal
 */
export { parseQuery as parseQueryForTest };

// ---------------------------------------------------------------------------
// LaunchRequestHandler
// ---------------------------------------------------------------------------

export const LaunchRequestHandler: RequestHandler = {
  canHandle(input) {
    return input.requestEnvelope.request.type === "LaunchRequest";
  },
  async handle(input): Promise<Response> {
    let nowPlaying: lms.NowPlayingResult | null = null;
    try {
      nowPlaying = await lms.nowPlaying();
    } catch {
      /* not fatal */
    }

    const speechText = nowPlaying?.is_playing
      ? `Squeezebox is playing ${nowPlaying.track?.title ?? "something"}. What would you like to do?`
      : "Squeezebox is ready.";

    const builder = input.responseBuilder
      .speak(speechText)
      .reprompt("What would you like to play?");

    if (supportsApl(input) && nowPlaying?.track) {
      const ap = audioPlayerState(input);
      const state = decodeQueueState(ap?.token);
      builder.addDirective(
        buildNowPlayingApl(
          nowPlaying.track,
          buildNowPlayingAplMeta(
            nowPlaying.track,
            state,
            ap?.offsetInMilliseconds ?? 0,
          ),
        ),
      );
    }

    return builder.getResponse();
  },
};

// ---------------------------------------------------------------------------
// PlayTrackIntent  – "play {SearchQuery}"
// Slot: SearchQuery (AMAZON.SearchQuery) — the only music search slot
// available in en-GB
// ---------------------------------------------------------------------------

export const PlayTrackIntentHandler: RequestHandler = {
  canHandle(input) {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      (input.requestEnvelope.request as any).intent.name === "PlayTrackIntent"
    );
  },
  async handle(input): Promise<Response> {
    if (!supportsAudio(input)) {
      return input.responseBuilder
        .speak("Sorry, this device doesn't support audio playback.")
        .getResponse();
    }

    const query = getSlotValue(input, "SearchQuery");
    if (!query) {
      return input.responseBuilder
        .speak("What would you like to play?")
        .reprompt("What would you like to play?")
        .getResponse();
    }

    let tracks: lms.LmsTrack[];
    let speech: string;

    try {
      const resolved = await resolvePlayQuery(query);
      tracks = resolved.tracks;
      speech = resolved.speech;
    } catch (err) {
      return input.responseBuilder.speak(speechForLmsError(err)).getResponse();
    }

    if (!tracks.length) {
      return input.responseBuilder
        .speak(`Sorry, I couldn't find anything matching ${query}.`)
        .getResponse();
    }

    const queue = tracks.map((t) => t.id);
    const token = encodeQueueState(queue, 0);

    const response = input.responseBuilder
      .speak(speech)
      .addDirective(playDirective(tracks[0], "REPLACE_ALL", undefined, token))
      .withShouldEndSession(true);

    return response.getResponse();
  },
};

// ---------------------------------------------------------------------------
// PlayAlbumIntent  – "play the album {SearchQuery}"
// Loads all tracks into a queue via successive ENQUEUE directives.
// Only the first track is sent immediately; subsequent tracks are enqueued
// via AudioPlayer.PlaybackNearlyFinished events (see AudioPlayerHandlers).
// ---------------------------------------------------------------------------

export const PlayAlbumIntentHandler: RequestHandler = {
  canHandle(input) {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      (input.requestEnvelope.request as any).intent.name === "PlayAlbumIntent"
    );
  },
  async handle(input): Promise<Response> {
    if (!supportsAudio(input)) {
      return input.responseBuilder
        .speak("Sorry, this device doesn't support audio playback.")
        .getResponse();
    }

    const query = getSlotValue(input, "SearchQuery");
    if (!query) {
      return input.responseBuilder
        .speak("Which album would you like to play?")
        .reprompt("Which album?")
        .getResponse();
    }

    // resolvePlayQuery already tries album first, so this covers
    // "play the album Dark Side of the Moon by Pink Floyd" etc.
    let tracks: lms.LmsTrack[];
    let speech: string;

    try {
      const resolved = await resolvePlayQuery(query);
      tracks = resolved.tracks;
      speech = resolved.speech;
    } catch (err) {
      return input.responseBuilder.speak(speechForLmsError(err)).getResponse();
    }

    if (!tracks.length) {
      return input.responseBuilder
        .speak(`Sorry, I couldn't find an album matching ${query}.`)
        .getResponse();
    }

    const queue = tracks.map((t) => t.id);
    const token = encodeQueueState(queue, 0);

    const response = input.responseBuilder
      .speak(speech)
      .addDirective(playDirective(tracks[0], "REPLACE_ALL", undefined, token))
      .withShouldEndSession(true);

    return response.getResponse();
  },
};

// ---------------------------------------------------------------------------
// PlayArtistIntent  – "play {SearchQuery}"  (artist mode)
// ---------------------------------------------------------------------------

export const PlayArtistIntentHandler: RequestHandler = {
  canHandle(input) {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      (input.requestEnvelope.request as any).intent.name === "PlayArtistIntent"
    );
  },
  async handle(input): Promise<Response> {
    if (!supportsAudio(input)) {
      return input.responseBuilder
        .speak("Sorry, this device doesn't support audio playback.")
        .getResponse();
    }

    const query = getSlotValue(input, "SearchQuery");
    if (!query) {
      return input.responseBuilder
        .speak("Which artist would you like to play?")
        .reprompt("Which artist?")
        .getResponse();
    }

    let tracks: lms.LmsTrack[];
    try {
      const { results } = await lms.search(query, "track");
      tracks = results as lms.LmsTrack[];
    } catch (err) {
      return input.responseBuilder.speak(speechForLmsError(err)).getResponse();
    }

    if (!tracks.length) {
      return input.responseBuilder
        .speak(`Sorry, I couldn't find any tracks by ${query}.`)
        .getResponse();
    }
    const queue = tracks.map((t) => t.id);
    const token = encodeQueueState(queue, 0);

    const response = input.responseBuilder
      .speak(`Playing music by ${query}.`)
      .addDirective(playDirective(tracks[0], "REPLACE_ALL", undefined, token))
      .withShouldEndSession(true);

    return response.getResponse();
  },
};

// ---------------------------------------------------------------------------
// Pause / Resume / Stop  (AMAZON built-ins – available in en-GB)
// ---------------------------------------------------------------------------

export const PauseIntentHandler: RequestHandler = {
  canHandle(input) {
    const reqType = requestType(input);
    if (
      reqType === "PlaybackController.PauseCommandIssued" ||
      reqType === "PlaybackController.PauseCommand"
    ) {
      return true;
    }
    return (
      reqType === "IntentRequest" &&
      (input.requestEnvelope.request as any).intent.name ===
        "AMAZON.PauseIntent"
    );
  },
  async handle(input): Promise<Response> {
    const ap = audioPlayerState(input);
    const state = decodeQueueState(ap?.token);
    const offsetMs = ap?.offsetInMilliseconds ?? 0;
    void lms.reportPlayback(
      "paused",
      state ? state.queue[state.index] : undefined,
      offsetMs,
    );
    const response = input.responseBuilder.addDirective({
      type: "AudioPlayer.Stop",
    });

    if (!isPlaybackControllerRequest(input)) {
      response.withShouldEndSession(true);
    }

    return response.getResponse();
  },
};

export const ResumeIntentHandler: RequestHandler = {
  canHandle(input) {
    const reqType = requestType(input);
    if (
      reqType === "PlaybackController.PlayCommandIssued" ||
      reqType === "PlaybackController.PlayCommand"
    ) {
      return true;
    }
    return (
      reqType === "IntentRequest" &&
      (input.requestEnvelope.request as any).intent.name ===
        "AMAZON.ResumeIntent"
    );
  },
  async handle(input): Promise<Response> {
    // Resume Alexa's own AudioPlayer at the offset it paused at
    const ap = audioPlayerState(input);
    const state = decodeQueueState(ap?.token);
    if (!state) {
      if (isPlaybackControllerRequest(input)) {
        return input.responseBuilder.getResponse();
      }
      return input.responseBuilder.speak("Nothing to resume.").getResponse();
    }

    const offsetMs = ap?.offsetInMilliseconds ?? 0;
    const trackId = state.queue[state.index];

    // Fetch track metadata (needed for signed stream URL)
    let track: lms.LmsTrack;
    try {
      track = await lms.getTrack(trackId);
    } catch {
      if (isPlaybackControllerRequest(input)) {
        return input.responseBuilder.getResponse();
      }
      return input.responseBuilder.speak("Nothing to resume.").getResponse();
    }

    const directive = playDirective(
      track,
      "REPLACE_ALL",
      undefined,
      encodeQueueState(state.queue, state.index),
    );
    (directive.audioItem!.stream as any).offsetInMilliseconds = offsetMs;

    void lms.reportPlayback("playing", trackId, offsetMs);

    const response = input.responseBuilder.addDirective(directive);

    if (!isPlaybackControllerRequest(input)) {
      response.withShouldEndSession(true);
    }

    return response.getResponse();
  },
};

export const StopIntentHandler: RequestHandler = {
  canHandle(input) {
    const reqType = input.requestEnvelope.request.type;
    const intentName =
      reqType === "IntentRequest"
        ? (input.requestEnvelope.request as any).intent.name
        : "";
    return (
      reqType === "IntentRequest" &&
      (intentName === "AMAZON.StopIntent" ||
        intentName === "AMAZON.CancelIntent")
    );
  },
  async handle(input): Promise<Response> {
    void lms.reportPlayback("stopped");
    return input.responseBuilder
      .speak("Stopping.")
      .addDirective({ type: "AudioPlayer.Stop" })
      .withShouldEndSession(true)
      .getResponse();
  },
};

// ---------------------------------------------------------------------------
// Next / Previous  (AMAZON built-ins – available in en-GB)
// ---------------------------------------------------------------------------

export const NextIntentHandler: RequestHandler = {
  canHandle(input) {
    const reqType = requestType(input);
    if (
      reqType === "PlaybackController.NextCommandIssued" ||
      reqType === "PlaybackController.NextCommand"
    ) {
      return true;
    }
    return (
      reqType === "IntentRequest" &&
      (input.requestEnvelope.request as any).intent.name === "AMAZON.NextIntent"
    );
  },
  async handle(input): Promise<Response> {
    const state = decodeQueueState(audioPlayerState(input)?.token);
    if (!state) {
      if (isPlaybackControllerRequest(input)) {
        return input.responseBuilder.getResponse();
      }
      return input.responseBuilder
        .speak("There isn't an active queue to skip.")
        .withShouldEndSession(true)
        .getResponse();
    }
    const idx = state.index + 1;

    if (idx >= state.queue.length) {
      if (isPlaybackControllerRequest(input)) {
        return input.responseBuilder.getResponse();
      }
      return input.responseBuilder
        .speak("That's the end of the queue.")
        .withShouldEndSession(true)
        .getResponse();
    }

    const trackId = state.queue[idx];
    let track: lms.LmsTrack;
    try {
      track = await lms.getTrack(trackId);
    } catch {
      if (isPlaybackControllerRequest(input)) {
        return input.responseBuilder.getResponse();
      }
      return input.responseBuilder
        .speak("Sorry, I couldn't find the next track.")
        .withShouldEndSession(true)
        .getResponse();
    }

    const response = input.responseBuilder.addDirective(
      playDirective(
        track,
        "REPLACE_ALL",
        undefined,
        encodeQueueState(state.queue, idx),
      ),
    );

    if (!isPlaybackControllerRequest(input)) {
      response.withShouldEndSession(true);
    }

    return response.getResponse();
  },
};

export const PreviousIntentHandler: RequestHandler = {
  canHandle(input) {
    const reqType = requestType(input);
    if (
      reqType === "PlaybackController.PreviousCommandIssued" ||
      reqType === "PlaybackController.PreviousCommand"
    ) {
      return true;
    }
    return (
      reqType === "IntentRequest" &&
      (input.requestEnvelope.request as any).intent.name ===
        "AMAZON.PreviousIntent"
    );
  },
  async handle(input): Promise<Response> {
    const state = decodeQueueState(audioPlayerState(input)?.token);
    if (!state) {
      if (isPlaybackControllerRequest(input)) {
        return input.responseBuilder.getResponse();
      }
      return input.responseBuilder
        .speak("There isn't an active queue to go back in.")
        .withShouldEndSession(true)
        .getResponse();
    }
    const idx = state.index - 1;

    if (idx < 0) {
      if (isPlaybackControllerRequest(input)) {
        return input.responseBuilder.getResponse();
      }
      return input.responseBuilder
        .speak("That's the start of the queue.")
        .withShouldEndSession(true)
        .getResponse();
    }

    const trackId = state.queue[idx];
    let track: lms.LmsTrack;
    try {
      track = await lms.getTrack(trackId);
    } catch {
      if (isPlaybackControllerRequest(input)) {
        return input.responseBuilder.getResponse();
      }
      return input.responseBuilder
        .speak("Sorry, I couldn't find the previous track.")
        .withShouldEndSession(true)
        .getResponse();
    }

    const response = input.responseBuilder.addDirective(
      playDirective(
        track,
        "REPLACE_ALL",
        undefined,
        encodeQueueState(state.queue, idx),
      ),
    );

    if (!isPlaybackControllerRequest(input)) {
      response.withShouldEndSession(true);
    }

    return response.getResponse();
  },
};

// ---------------------------------------------------------------------------
// APL UserEvent controls (Echo Show touch buttons)
// ---------------------------------------------------------------------------

export const AplUserEventHandler: RequestHandler = {
  canHandle(input) {
    return (
      input.requestEnvelope.request.type === "Alexa.Presentation.APL.UserEvent"
    );
  },
  async handle(input): Promise<Response> {
    const request = input.requestEnvelope.request as any;
    const action = String(request.arguments?.[0] ?? "").toLowerCase();

    if (action === "refreshprogress") {
      const ap = audioPlayerState(input);
      if (ap?.playerActivity !== "PLAYING") {
        return input.responseBuilder.getResponse();
      }

      const state = decodeQueueState(ap?.token);
      if (!state) {
        return input.responseBuilder.getResponse();
      }

      const trackId = state.queue[state.index];
      let track: lms.LmsTrack;
      try {
        track = await lms.getTrack(trackId);
      } catch {
        return input.responseBuilder.getResponse();
      }

      return input.responseBuilder
        .addDirective(
          buildNowPlayingApl(
            track,
            buildNowPlayingAplMeta(track, state, ap?.offsetInMilliseconds ?? 0),
          ),
        )
        .withShouldEndSession(true)
        .getResponse();
    }

    if (action === "pause") {
      const ap = audioPlayerState(input);
      const state = decodeQueueState(ap?.token);
      const offsetMs = ap?.offsetInMilliseconds ?? 0;
      void lms.reportPlayback(
        "paused",
        state ? state.queue[state.index] : undefined,
        offsetMs,
      );
      return input.responseBuilder
        .addDirective({ type: "AudioPlayer.Stop" })
        .withShouldEndSession(true)
        .getResponse();
    }

    if (action === "stop") {
      void lms.reportPlayback("stopped");
      return input.responseBuilder
        .addDirective({ type: "AudioPlayer.Stop" })
        .withShouldEndSession(true)
        .getResponse();
    }

    if (action === "next" || action === "previous") {
      const state = decodeQueueState(audioPlayerState(input)?.token);
      if (!state) {
        return input.responseBuilder
          .speak("There isn't an active queue.")
          .withShouldEndSession(true)
          .getResponse();
      }

      const idx = action === "next" ? state.index + 1 : state.index - 1;
      if (idx < 0 || idx >= state.queue.length) {
        return input.responseBuilder
          .speak(
            action === "next"
              ? "That's the end of the queue."
              : "That's the start of the queue.",
          )
          .withShouldEndSession(true)
          .getResponse();
      }

      const trackId = state.queue[idx];
      let track: lms.LmsTrack;
      try {
        track = await lms.getTrack(trackId);
      } catch {
        return input.responseBuilder
          .speak("Sorry, I couldn't load that track.")
          .withShouldEndSession(true)
          .getResponse();
      }

      return input.responseBuilder
        .addDirective(
          playDirective(
            track,
            "REPLACE_ALL",
            undefined,
            encodeQueueState(state.queue, idx),
          ),
        )
        .withShouldEndSession(true)
        .getResponse();
    }

    return input.responseBuilder.getResponse();
  },
};

// ---------------------------------------------------------------------------
// VolumeIntent  – "set volume to {Volume}"
// Slot: Volume (AMAZON.NUMBER) – available in en-GB
// ---------------------------------------------------------------------------

export const VolumeIntentHandler: RequestHandler = {
  canHandle(input) {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      (input.requestEnvelope.request as any).intent.name === "VolumeIntent"
    );
  },
  async handle(input): Promise<Response> {
    const raw = getSlotValue(input, "Volume");
    const vol = raw ? Math.min(100, Math.max(0, parseInt(raw, 10))) : NaN;

    if (isNaN(vol)) {
      return input.responseBuilder
        .speak("What volume would you like? Say a number between 0 and 100.")
        .reprompt("What volume?")
        .getResponse();
    }

    await lms.control("volume", vol);
    return input.responseBuilder
      .speak(`Volume set to ${vol}.`)
      .withShouldEndSession(true)
      .getResponse();
  },
};

// ---------------------------------------------------------------------------
// NowPlayingIntent  – "what's playing?"
// ---------------------------------------------------------------------------

export const NowPlayingIntentHandler: RequestHandler = {
  canHandle(input) {
    return (
      input.requestEnvelope.request.type === "IntentRequest" &&
      (input.requestEnvelope.request as any).intent.name === "NowPlayingIntent"
    );
  },
  async handle(input): Promise<Response> {
    let np: Awaited<ReturnType<typeof lms.nowPlaying>>;
    try {
      np = await lms.nowPlaying();
    } catch {
      return input.responseBuilder
        .speak("Sorry, I couldn't reach the music server. Please try again.")
        .getResponse();
    }

    if (!np.track || !np.is_playing) {
      return input.responseBuilder
        .speak("Nothing is playing right now.")
        .getResponse();
    }

    const speech = `Now playing: ${np.track.title} by ${np.track.artist}, from the album ${np.track.album}.`;
    const response = input.responseBuilder.speak(speech);

    if (supportsApl(input)) {
      const ap = audioPlayerState(input);
      const state = decodeQueueState(ap?.token);
      response.addDirective(
        buildNowPlayingApl(
          np.track,
          buildNowPlayingAplMeta(
            np.track,
            state,
            ap?.offsetInMilliseconds ?? 0,
          ),
        ),
      );
    }

    return response.getResponse();
  },
};

// ---------------------------------------------------------------------------
// AudioPlayer event handlers
// Required for any skill using the AudioPlayer interface.
// ---------------------------------------------------------------------------

export const AudioPlayerHandlers: RequestHandler[] = [
  {
    // PlaybackStarted – update shadow state to playing
    canHandle: (input) =>
      input.requestEnvelope.request.type === "AudioPlayer.PlaybackStarted",
    async handle(input): Promise<Response> {
      const token = (input.requestEnvelope.request as any).token as
        | string
        | undefined;
      const offsetMs =
        (input.requestEnvelope.request as any).offsetInMilliseconds ?? 0;
      const state = decodeQueueState(token);
      void lms.reportPlayback(
        "playing",
        state ? state.queue[state.index] : undefined,
        offsetMs,
      );
      return input.responseBuilder.getResponse();
    },
  },
  {
    // Fired when Alexa is about to finish the current track — enqueue the next
    canHandle: (input) =>
      input.requestEnvelope.request.type ===
      "AudioPlayer.PlaybackNearlyFinished",
    async handle(input): Promise<Response> {
      const currentToken = (input.requestEnvelope.request as any).token as
        | string
        | undefined;
      const state = decodeQueueState(currentToken);
      if (!state) {
        return input.responseBuilder.getResponse();
      }
      const idx = state.index + 1;
      if (idx >= state.queue.length) {
        return input.responseBuilder.getResponse();
      }
      const nextTrackId = state.queue[idx];

      // Fetch track metadata (needed for signed stream_url)
      let next: lms.LmsTrack;
      try {
        next = await lms.getTrack(nextTrackId);
      } catch {
        return input.responseBuilder.getResponse();
      }

      const nextToken = encodeQueueState(state.queue, idx);

      return input.responseBuilder
        .addDirective(playDirective(next, "ENQUEUE", currentToken, nextToken))
        .getResponse();
    },
  },
  {
    canHandle: (input) =>
      input.requestEnvelope.request.type === "AudioPlayer.PlaybackFinished",
    handle: (input) => {
      void lms.reportPlayback("stopped");
      return input.responseBuilder.getResponse();
    },
  },
  {
    canHandle: (input) =>
      input.requestEnvelope.request.type === "AudioPlayer.PlaybackStopped",
    handle: (input) => {
      const token = (input.requestEnvelope.request as any).token as
        | string
        | undefined;
      const offsetMs =
        (input.requestEnvelope.request as any).offsetInMilliseconds ?? 0;
      const state = decodeQueueState(token);
      void lms.reportPlayback(
        "paused",
        state ? state.queue[state.index] : undefined,
        offsetMs,
      );
      return input.responseBuilder.getResponse();
    },
  },
  {
    canHandle: (input) =>
      input.requestEnvelope.request.type === "AudioPlayer.PlaybackFailed",
    handle: (input) => {
      console.error(
        "AudioPlayer.PlaybackFailed",
        JSON.stringify((input.requestEnvelope.request as any).error),
      );
      return input.responseBuilder.getResponse();
    },
  },
];

// Required by Alexa when AudioPlayer is enabled
export const PlaybackControllerHandlers: RequestHandler[] = [
  {
    canHandle: (input) =>
      input.requestEnvelope.request.type.startsWith("PlaybackController."),
    handle: (input) => input.responseBuilder.getResponse(),
  },
];

// ---------------------------------------------------------------------------
// SessionEndedRequestHandler
// ---------------------------------------------------------------------------

export const SessionEndedRequestHandler: RequestHandler = {
  canHandle(input) {
    return input.requestEnvelope.request.type === "SessionEndedRequest";
  },
  handle(input): Response {
    const reason = (input.requestEnvelope.request as any).reason;
    if (reason === "ERROR") {
      console.error(
        "Session ended with error:",
        JSON.stringify((input.requestEnvelope.request as any).error),
      );
    }
    return input.responseBuilder.getResponse();
  },
};

// ---------------------------------------------------------------------------
// ErrorHandler
// ---------------------------------------------------------------------------

export const ErrorHandler: IErrorHandler = {
  canHandle: () => true,
  handle(input, error): Response {
    console.error("Unhandled error:", error.message, error.stack);
    return input.responseBuilder
      .speak("Sorry, something went wrong. Please try again.")
      .getResponse();
  },
};
