import {
  AudioPlayerHandlers,
  NextIntentHandler,
  PlayAlbumIntentHandler,
} from "./handlers";
import * as lms from "./lmsClient";
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("./lmsClient", () => ({
  search: jest.fn(),
  albumTracks: jest.fn(),
  getTrack: jest.fn(),
  nowPlaying: jest.fn(),
  control: jest.fn(),
}));

jest.mock("./aplBuilder", () => ({
  buildNowPlayingApl: jest.fn(() => ({
    type: "Alexa.Presentation.APL.RenderDocument",
  })),
}));

class FakeResponseBuilder {
  private response: any = {};

  speak(text: string) {
    this.response.outputSpeech = { type: "PlainText", text };
    return this;
  }

  reprompt(text: string) {
    this.response.reprompt = { outputSpeech: { type: "PlainText", text } };
    return this;
  }

  addDirective(directive: any) {
    if (!this.response.directives) {
      this.response.directives = [];
    }
    this.response.directives.push(directive);
    return this;
  }

  withShouldEndSession(value: boolean) {
    this.response.shouldEndSession = value;
    return this;
  }

  getResponse() {
    return this.response;
  }
}

function makeInput(request: any, token?: string) {
  const attrs: Record<string, any> = {};
  return {
    requestEnvelope: {
      context: {
        System: {
          device: {
            supportedInterfaces: {
              AudioPlayer: {},
            },
          },
        },
        AudioPlayer: token
          ? {
              token,
              offsetInMilliseconds: 1234,
              playerActivity: "PLAYING",
            }
          : undefined,
      },
      request,
    },
    responseBuilder: new FakeResponseBuilder(),
    attributesManager: {
      getSessionAttributes: () => attrs,
      setSessionAttributes: (next: Record<string, any>) => {
        Object.assign(attrs, next);
      },
    },
  } as any;
}

function decodeToken(token: string) {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
    queue: number[];
    index: number;
  };
}

describe("handlers queue token flow", () => {
  const mockedLms = lms as jest.Mocked<typeof lms>;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  test("PlayAlbumIntent emits queue token in first track", async () => {
    mockedLms.search.mockResolvedValueOnce({
      results: [
        { id: 99, title: "Album", artist: "Artist", year: null } as any,
      ],
    });
    mockedLms.albumTracks.mockResolvedValueOnce({
      album: { id: 99, title: "Album", artist: "Artist", year: null } as any,
      tracks: [
        {
          id: 1,
          title: "T1",
          artist: "A",
          album: "Album",
          stream_url: "u1",
          artwork_url: "a1",
          duration: null,
          tracknum: 1,
        },
        {
          id: 2,
          title: "T2",
          artist: "A",
          album: "Album",
          stream_url: "u2",
          artwork_url: "a2",
          duration: null,
          tracknum: 2,
        },
        {
          id: 3,
          title: "T3",
          artist: "A",
          album: "Album",
          stream_url: "u3",
          artwork_url: "a3",
          duration: null,
          tracknum: 3,
        },
      ],
    });

    const input = makeInput({
      type: "IntentRequest",
      intent: {
        name: "PlayAlbumIntent",
        slots: {
          SearchQuery: { value: "Album" },
        },
      },
    });

    const response = await PlayAlbumIntentHandler.handle(input);
    const play = (response.directives as any[])[0] as any;

    expect(play.type).toBe("AudioPlayer.Play");
    expect(play.playBehavior).toBe("REPLACE_ALL");

    const state = decodeToken(play.audioItem.stream.token);
    expect(state.queue).toEqual([1, 2, 3]);
    expect(state.index).toBe(0);
  });

  test("PlaybackNearlyFinished enqueues next track using token state", async () => {
    const token = Buffer.from(
      JSON.stringify({ queue: [1, 2, 3], index: 0 }),
      "utf8",
    ).toString("base64url");

    mockedLms.getTrack.mockResolvedValueOnce({
      id: 2,
      title: "T2",
      artist: "A",
      album: "Album",
      stream_url: "u2",
      artwork_url: "a2",
      duration: null,
      tracknum: 2,
    } as any);

    const handler = AudioPlayerHandlers.find((h) =>
      h.canHandle(
        makeInput({ type: "AudioPlayer.PlaybackNearlyFinished", token }, token),
      ),
    );

    expect(handler).toBeDefined();
    const response = await handler!.handle(
      makeInput({ type: "AudioPlayer.PlaybackNearlyFinished", token }, token),
    );

    const play = (response.directives as any[])[0] as any;
    expect(play.type).toBe("AudioPlayer.Play");
    expect(play.playBehavior).toBe("ENQUEUE");
    expect(play.audioItem.stream.expectedPreviousToken).toBe(token);

    const nextState = decodeToken(play.audioItem.stream.token);
    expect(nextState.queue).toEqual([1, 2, 3]);
    expect(nextState.index).toBe(1);
  });

  test("NextCommand skips to next queued track", async () => {
    const token = Buffer.from(
      JSON.stringify({ queue: [10, 20, 30], index: 0 }),
      "utf8",
    ).toString("base64url");

    mockedLms.getTrack.mockResolvedValueOnce({
      id: 20,
      title: "T20",
      artist: "A",
      album: "Album",
      stream_url: "u20",
      artwork_url: "a20",
      duration: null,
      tracknum: 2,
    } as any);

    const response = await NextIntentHandler.handle(
      makeInput({ type: "PlaybackController.NextCommand" }, token),
    );

    const play = (response.directives as any[])[0] as any;
    expect(play.type).toBe("AudioPlayer.Play");
    expect(play.playBehavior).toBe("REPLACE_ALL");

    const state = decodeToken(play.audioItem.stream.token);
    expect(state.queue).toEqual([10, 20, 30]);
    expect(state.index).toBe(1);
  });
});
