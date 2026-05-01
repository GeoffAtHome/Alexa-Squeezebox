# Alexa-Squeezebox

An Alexa custom skill that lets you search and play music from a [Lyrion Music Server](https://lyrion.org) (LMS) library through any Alexa device.

## How it works

```
Voice → Alexa → AWS Lambda → LMS REST API (AlexaBridge plugin)
                                    ↓
                         Signed audio stream URL
                                    ↓
                     Alexa AudioPlayer fetches and plays audio
```

1. You speak a command to Alexa ("ask Squeezebox to play the album Dark Side of the Moon")
2. The Lambda function queries the AlexaBridge LMS plugin to search the library
3. LMS returns track metadata and signed stream URLs
4. Lambda returns an `AudioPlayer.Play` directive — Alexa fetches the audio directly from LMS and plays it through its speaker

## Repository structure

```
skill-package/
  skill.json                          Alexa skill manifest (endpoint, permissions)
  interactionModels/custom/en-GB.json NLU model — intents, slots, sample utterances

lambda/
  src/
    index.ts        Lambda entry point, skill builder
    handlers.ts     All Alexa request/intent handlers
    lmsClient.ts    Typed HTTP client for the AlexaBridge REST API
    aplBuilder.ts   Echo Show APL display templates
  package.json
  tsconfig.json

lms-plugin/AlexaBridge/
  Plugin.pm         Main plugin — REST API, HMAC auth, LMS request dispatcher
  Settings.pm       LMS settings page handler
  strings.txt       Localisation strings
  install.xml       Plugin metadata (local install format)
  HTML/             LMS settings page template

ask-resources.json  ASK CLI project config
```

## Prerequisites

| Component                | Requirement                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| LMS                      | Lyrion Music Server 9.x on Windows/Linux/Mac                         |
| Public HTTPS URL         | LMS must be reachable from the internet (e.g. via Cloudflare tunnel) |
| AWS account              | Lambda function in eu-west-1 (or your preferred region)              |
| Amazon Developer account | For creating and managing the Alexa skill                            |
| Node.js                  | v20+ for local development                                           |
| ASK CLI                  | v2 (`npm install -g ask-cli`)                                        |

## Setup

### 1. Install the AlexaBridge LMS plugin

Copy the `lms-plugin/AlexaBridge/` folder to your LMS plugins directory:

- **Windows**: `C:\Program Files\Lyrion\server\Plugins\AlexaBridge\`
- **Linux**: `/usr/share/lyrion/server/Plugins/AlexaBridge/`

Restart LMS. The plugin will appear in **Settings → Plugins**.

### 2. Configure the plugin secret

Either use the settings page (Settings → AlexaBridge) or edit the prefs file directly:

**Windows**: `C:\ProgramData\Lyrion\prefs\plugin\alexabridge.prefs`

```yaml
secret: your-chosen-secret-here
token_ttl: 86400
```

Restart LMS after editing the prefs file.

### 3. Generate the API token

The API token is HMAC-SHA1 of the string `api` using your secret as the key:

```bash
echo -n "api" | openssl dgst -sha1 -hmac "your-chosen-secret-here"
```

Verify it works:

```
GET https://your-lms-domain.com/alexa/players?token=<your-token>
```

Expected response: `{"players":[...]}`

### 4. Deploy the Lambda function

```bash
cd lambda
npm install
npm run build
```

Create a deployment zip (contents at root level, not in a subdirectory):

```powershell
# PowerShell example
$zip = [System.IO.Compression.ZipFile]::Open("lambda.zip", 'Create')
# Add dist/ and node_modules/ entries...
$zip.Dispose()

aws lambda update-function-code \
  --region eu-west-1 \
  --function-name alexa-squeezebox \
  --zip-file fileb://lambda.zip
```

Set the required environment variables on the Lambda function:

| Variable        | Value                                             |
| --------------- | ------------------------------------------------- |
| `LMS_BASE_URL`  | `https://your-lms-domain.com` (no trailing slash) |
| `LMS_API_TOKEN` | Token generated in step 3                         |
| `LMS_PLAYER_ID` | Player MAC address from `GET /alexa/players`      |

### 5. Create the Alexa skill

```bash
ask deploy --profile default
```

Or upload the interaction model manually:

```bash
ask smapi set-interaction-model \
  --skill-id <your-skill-id> \
  --stage development \
  --device-locale en-GB \
  --interaction-model "file:skill-package/interactionModels/custom/en-GB.json"
```

Enable the skill on your account for testing:

```bash
ask smapi set-skill-enablement \
  --skill-id <your-skill-id> \
  --stage development
```

## Voice commands

| Say                           | Action                               |
| ----------------------------- | ------------------------------------ |
| "Alexa, open Squeezebox"      | Launch the skill                     |
| "play [song name]"            | Search and play a track              |
| "play the album [album name]" | Play a full album                    |
| "play something by [artist]"  | Play tracks by an artist             |
| "pause"                       | Pause playback                       |
| "resume"                      | Resume from where it paused          |
| "next" / "previous"           | Skip tracks within the current queue |
| "stop"                        | Stop playback                        |
| "set volume to [0-100]"       | Adjust volume                        |
| "what's playing?"             | Announce current track               |

## AlexaBridge REST API

All endpoints (except `/alexa/stream`) require `?token=<api-token>`.

| Method | Path                                                | Description                                                 |
| ------ | --------------------------------------------------- | ----------------------------------------------------------- |
| GET    | `/alexa/search?q=<query>&type=track\|album\|artist` | Search the library                                          |
| GET    | `/alexa/track/<id>`                                 | Fetch a single track by LMS database ID                     |
| GET    | `/alexa/album/<id>/tracks`                          | Get all tracks in an album                                  |
| GET    | `/alexa/nowplaying?player=<id>`                     | Current playback state for a player                         |
| GET    | `/alexa/control?player=<id>&cmd=<cmd>`              | Send playback command to a player                           |
| GET    | `/alexa/players`                                    | List all connected LMS players                              |
| GET    | `/alexa/stream/<id>?exp=<ts>&sig=<hmac>`            | Serve/redirect audio (self-signed URL, no API token needed) |

Stream URLs are signed with HMAC-SHA1 and expire after `token_ttl` seconds (default 24 hours).

## Development

```bash
cd lambda
npm install       # install all deps including devDependencies
npm run build     # compile TypeScript → dist/
```

To redeploy after changes, rebuild and re-upload the zip. The ASK CLI default profile may have expired session credentials; use a long-lived IAM profile instead:

```bash
aws lambda update-function-code \
  --region eu-west-1 \
  --function-name alexa-squeezebox \
  --zip-file fileb://lambda.zip \
  --profile <your-iam-profile>
```
