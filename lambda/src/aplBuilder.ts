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

export interface NowPlayingAplMeta {
  elapsedLabel?: string;
  durationLabel?: string;
  progressWidth?: string;
  showProgress?: boolean;
  trackPositionLabel?: string;
  autoRefresh?: boolean;
}

export function buildNowPlayingApl(
  track: LmsTrack,
  meta: NowPlayingAplMeta = {},
): AplDirective {
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
          elapsedLabel: meta.elapsedLabel ?? "0:00",
          durationLabel: meta.durationLabel ?? "--:--",
          progressWidth: meta.progressWidth ?? "0%",
          showProgress: meta.showProgress ?? false,
          trackPositionLabel: meta.trackPositionLabel ?? "",
          autoRefresh: meta.autoRefresh ?? false,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// APL 1.8 document — compatible with all Echo Show models sold in the UK.
// Uses AlexaBackground + a centred card layout.
// ---------------------------------------------------------------------------

const ICON_PREVIOUS =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cpolygon fill='white' points='30,32 52,16 52,48'/%3E%3Cpolygon fill='white' points='10,32 32,16 32,48'/%3E%3C/svg%3E";
const ICON_PAUSE =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='14' y='12' width='12' height='40' fill='white'/%3E%3Crect x='38' y='12' width='12' height='40' fill='white'/%3E%3C/svg%3E";
const ICON_STOP =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='16' y='16' width='32' height='32' fill='white'/%3E%3C/svg%3E";
const ICON_NEXT =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cpolygon fill='white' points='34,32 12,16 12,48'/%3E%3Cpolygon fill='white' points='54,32 32,16 32,48'/%3E%3C/svg%3E";

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
              {
                type: "Text",
                when: "${nowPlaying.trackPositionLabel}",
                text: "${nowPlaying.trackPositionLabel}",
                style: "textStyleBody2",
                textAlign: "center",
                maxLines: 1,
                paddingTop: "8dp",
                color: "#DDDDDD",
              },
              {
                type: "Container",
                when: "${nowPlaying.showProgress}",
                width: "68vw",
                paddingTop: "10dp",
                onMount: [
                  {
                    type: "Idle",
                    delay: 2000,
                  },
                  {
                    type: "SendEvent",
                    when: "${nowPlaying.autoRefresh}",
                    arguments: ["refreshProgress"],
                  },
                ],
                items: [
                  {
                    type: "Container",
                    direction: "row",
                    justifyContent: "spaceBetween",
                    width: "100%",
                    items: [
                      {
                        type: "Text",
                        text: "${nowPlaying.elapsedLabel}",
                        style: "textStyleBody2",
                        color: "#DDDDDD",
                      },
                      {
                        type: "Text",
                        text: "${nowPlaying.durationLabel}",
                        style: "textStyleBody2",
                        color: "#DDDDDD",
                      },
                    ],
                  },
                  {
                    type: "Container",
                    width: "100%",
                    height: "8dp",
                    borderRadius: "4dp",
                    backgroundColor: "#3A3A3A",
                    paddingTop: "0dp",
                    marginTop: "6dp",
                    items: [
                      {
                        type: "Frame",
                        width: "${nowPlaying.progressWidth}",
                        height: "8dp",
                        borderRadius: "4dp",
                        backgroundColor: "#FFFFFF",
                      },
                    ],
                  },
                ],
              },
              // Echo Show playback controls
              {
                type: "Container",
                direction: "row",
                spacing: "12dp",
                paddingTop: "20dp",
                items: [
                  {
                    type: "TouchWrapper",
                    onPress: [
                      {
                        type: "SetValue",
                        componentId: "btn-previous",
                        property: "opacity",
                        value: 0.72,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-previous",
                        property: "transform",
                        value: [{ scale: 0.96 }],
                      },
                      {
                        type: "Idle",
                        delay: 85,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-previous",
                        property: "opacity",
                        value: 1,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-previous",
                        property: "transform",
                        value: [{ scale: 1 }],
                      },
                      {
                        type: "SendEvent",
                        arguments: ["previous"],
                      },
                    ],
                    item: {
                      type: "Container",
                      id: "btn-previous",
                      width: "60dp",
                      height: "60dp",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "#2A2A2A",
                      borderRadius: "10dp",
                      items: [
                        {
                          type: "Image",
                          source: ICON_PREVIOUS,
                          width: "28dp",
                          height: "28dp",
                        },
                      ],
                    },
                  },
                  {
                    type: "TouchWrapper",
                    onPress: [
                      {
                        type: "SetValue",
                        componentId: "btn-pause",
                        property: "opacity",
                        value: 0.72,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-pause",
                        property: "transform",
                        value: [{ scale: 0.96 }],
                      },
                      {
                        type: "Idle",
                        delay: 85,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-pause",
                        property: "opacity",
                        value: 1,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-pause",
                        property: "transform",
                        value: [{ scale: 1 }],
                      },
                      {
                        type: "SendEvent",
                        arguments: ["pause"],
                      },
                    ],
                    item: {
                      type: "Container",
                      id: "btn-pause",
                      width: "60dp",
                      height: "60dp",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "#2A2A2A",
                      borderRadius: "10dp",
                      items: [
                        {
                          type: "Image",
                          source: ICON_PAUSE,
                          width: "28dp",
                          height: "28dp",
                        },
                      ],
                    },
                  },
                  {
                    type: "TouchWrapper",
                    onPress: [
                      {
                        type: "SetValue",
                        componentId: "btn-stop",
                        property: "opacity",
                        value: 0.72,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-stop",
                        property: "transform",
                        value: [{ scale: 0.96 }],
                      },
                      {
                        type: "Idle",
                        delay: 85,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-stop",
                        property: "opacity",
                        value: 1,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-stop",
                        property: "transform",
                        value: [{ scale: 1 }],
                      },
                      {
                        type: "SendEvent",
                        arguments: ["stop"],
                      },
                    ],
                    item: {
                      type: "Container",
                      id: "btn-stop",
                      width: "60dp",
                      height: "60dp",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "#2A2A2A",
                      borderRadius: "10dp",
                      items: [
                        {
                          type: "Image",
                          source: ICON_STOP,
                          width: "28dp",
                          height: "28dp",
                        },
                      ],
                    },
                  },
                  {
                    type: "TouchWrapper",
                    onPress: [
                      {
                        type: "SetValue",
                        componentId: "btn-next",
                        property: "opacity",
                        value: 0.72,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-next",
                        property: "transform",
                        value: [{ scale: 0.96 }],
                      },
                      {
                        type: "Idle",
                        delay: 85,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-next",
                        property: "opacity",
                        value: 1,
                      },
                      {
                        type: "SetValue",
                        componentId: "btn-next",
                        property: "transform",
                        value: [{ scale: 1 }],
                      },
                      {
                        type: "SendEvent",
                        arguments: ["next"],
                      },
                    ],
                    item: {
                      type: "Container",
                      id: "btn-next",
                      width: "60dp",
                      height: "60dp",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "#2A2A2A",
                      borderRadius: "10dp",
                      items: [
                        {
                          type: "Image",
                          source: ICON_NEXT,
                          width: "28dp",
                          height: "28dp",
                        },
                      ],
                    },
                  },
                ],
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
