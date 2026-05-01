/**
 * aplBuilder.ts
 *
 * Builds the Alexa.Presentation.APL.RenderDocument directive for Echo Show
 * devices.  Displays now-playing info: artwork, track title, artist, album.
 *
 * The APL document uses the built-in AlexaTextList component family so it
 * renders cleanly on all APL-capable screen sizes (Echo Show 5, 8, 10, 15).
 *
 * artwork_url is the fully-qualified Cloudflare HTTPS URL built by lmsClient.
 */

import { interfaces } from "ask-sdk-model";
import { LmsTrack } from "./lmsClient";

type AplDirective = interfaces.display.RenderTemplateDirective | any;

export function buildNowPlayingApl(track: LmsTrack): AplDirective {
  return {
    type: "Alexa.Presentation.APL.RenderDocument",
    token: `nowplaying-${track.id}`,
    document: APL_DOCUMENT,
    datasources: {
      nowPlaying: {
        type: "object",
        properties: {
          title: track.title,
          artist: track.artist,
          album: track.album,
          artworkUrl: track.artwork_url,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// APL 1.8 document — compatible with all Echo Show models sold in the UK.
// Uses AlexaBackground + a centred card layout.
// ---------------------------------------------------------------------------

const APL_DOCUMENT = {
  type: "APL",
  version: "1.8",
  settings: { idleTimeout: 30000 },
  theme: "dark",
  import: [
    { name: "alexa-layouts", version: "1.6.0" },
    { name: "alexa-viewport-profiles", version: "1.6.0" },
  ],
  mainTemplate: {
    parameters: ["nowPlaying"],
    items: [
      {
        type: "Container",
        width: "100vw",
        height: "100vh",
        items: [
          // Full-bleed blurred background artwork
          {
            type: "AlexaBackground",
            backgroundImageSource: "${nowPlaying.artworkUrl}",
            backgroundBlur: true,
            backgroundScale: "best-fill",
            colorOverlay: true,
          },
          // Centred content card
          {
            type: "Container",
            position: "absolute",
            width: "100vw",
            height: "100vh",
            alignItems: "center",
            justifyContent: "center",
            items: [
              // Album artwork
              {
                type: "Image",
                source: "${nowPlaying.artworkUrl}",
                width: "@imageWidthSquare",
                height: "@imageWidthSquare",
                scale: "best-fit",
                borderRadius: "12dp",
                align: "center",
              },
              // Track title
              {
                type: "Text",
                text: "${nowPlaying.title}",
                style: "textStyleDisplay3",
                textAlign: "center",
                maxLines: 2,
                paddingTop: "16dp",
                paddingLeft: "24dp",
                paddingRight: "24dp",
                color: "white",
              },
              // Artist
              {
                type: "Text",
                text: "${nowPlaying.artist}",
                style: "textStyleBody1",
                textAlign: "center",
                maxLines: 1,
                paddingTop: "4dp",
                color: "#CCCCCC",
              },
              // Album
              {
                type: "Text",
                text: "${nowPlaying.album}",
                style: "textStyleBody2",
                textAlign: "center",
                maxLines: 1,
                paddingTop: "2dp",
                color: "#AAAAAA",
              },
            ],
          },
        ],
      },
    ],
  },
  // Responsive image width: smaller on Echo Show 5, larger on 10/15
  resources: [
    {
      description: "Echo Show 5",
      when: "${@viewportProfile == @hubRoundSmall || @viewportProfile == @hubLandscapeSmall}",
      dimensions: { imageWidthSquare: "180dp" },
    },
    {
      description: "Echo Show 8",
      when: "${@viewportProfile == @hubLandscapeMedium}",
      dimensions: { imageWidthSquare: "240dp" },
    },
    {
      description: "Echo Show 10 / 15",
      dimensions: { imageWidthSquare: "320dp" },
    },
  ],
};
