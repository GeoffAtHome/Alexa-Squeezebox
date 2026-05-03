/**
 * index.ts
 *
 * Lambda entry point for the Alexa-Squeezebox skill.
 *
 * Environment variables required (set in Lambda console or ask-resources.json):
 *   LMS_BASE_URL      – https://lms.yourdomain.com  (Cloudflare HTTPS, no trailing slash)
 *   LMS_API_TOKEN     – from AlexaBridge plugin settings page
 *   LMS_PLAYER_ID     – target player ID (GET /alexa/players to discover)
 */

import { SkillBuilders } from "ask-sdk-core";
import {
  LaunchRequestHandler,
  PlayTrackIntentHandler,
  PlayAlbumIntentHandler,
  PlayArtistIntentHandler,
  PauseIntentHandler,
  ResumeIntentHandler,
  StopIntentHandler,
  NextIntentHandler,
  PreviousIntentHandler,
  AplUserEventHandler,
  VolumeIntentHandler,
  NowPlayingIntentHandler,
  AudioPlayerHandlers,
  PlaybackControllerHandlers,
  SessionEndedRequestHandler,
  ErrorHandler,
} from "./handlers";

export const handler = SkillBuilders.custom()
  .addRequestInterceptors({
    process(handlerInput) {
      const req = handlerInput.requestEnvelope.request as any;
      const intentName = req?.intent?.name;
      console.log(
        "AlexaRequest",
        JSON.stringify({
          type: req?.type,
          intent: intentName,
          locale: req?.locale,
        }),
      );
    },
  })
  .addRequestHandlers(
    LaunchRequestHandler,
    // Custom music intents (US built-ins not available in en-GB)
    PlayTrackIntentHandler,
    PlayAlbumIntentHandler,
    PlayArtistIntentHandler,
    // Custom utility intents
    VolumeIntentHandler,
    NowPlayingIntentHandler,
    // AMAZON built-ins supported in en-GB
    PauseIntentHandler,
    ResumeIntentHandler,
    StopIntentHandler,
    NextIntentHandler,
    PreviousIntentHandler,
    AplUserEventHandler,
    // AudioPlayer & PlaybackController lifecycle events
    ...AudioPlayerHandlers,
    ...PlaybackControllerHandlers,
    SessionEndedRequestHandler,
  )
  .addErrorHandlers(ErrorHandler)
  .lambda();
