package Plugins::AlexaBridge::Plugin;

# Alexa Bridge Plugin for Logitech Media Server
#
# Exposes a lightweight REST/JSON API over LMS's built-in HTTP server so that
# the Alexa-Squeezebox Lambda function can:
#   - Search the music library (tracks, albums, artists)
#   - Retrieve signed, time-limited audio stream URLs for Alexa AudioPlayer
#   - Fetch now-playing metadata (including artwork) for Echo Show APL
#   - Send playback control commands (pause, resume, next, prev, volume, stop)
#   - List available LMS players
#
# All endpoints (except /alexa/stream) require a shared-secret HMAC token
# passed as ?token=<value>.  Stream URLs carry their own per-track HMAC
# signature so they can be embedded directly in Alexa AudioPlayer directives.
#
# Base URL (set as LMS_BASE_URL in your Lambda):
#   https://lms.yourdomain.com  (Cloudflare-fronted, no trailing slash)
#
# Endpoints
# ---------
#   GET /alexa/search?q=<query>&type=track|album|artist&token=<t>
#   GET /alexa/album/<album_id>/tracks?token=<t>
#   GET /alexa/nowplaying?player=<id>&token=<t>
#   GET /alexa/control?player=<id>&cmd=pause|resume|next|prev|volume|stop&value=<v>&token=<t>
#   GET /alexa/players?token=<t>
#   GET /alexa/stream/<track_id>?exp=<unix_ts>&sig=<hmac>   ← no API token, self-signed
#   GET /alexa/playback?state=playing|paused|stopped&trackId=<id>&offsetMs=<ms>&token=<t>
#   GET /alexa/playback/current?token=<t>

use strict;
use warnings;

use base qw(Slim::Plugin::Base);

use Slim::Utils::Log;
use Slim::Utils::Prefs;
use Slim::Web::Pages;
use Slim::Web::HTTP;
use Slim::Schema;
use Slim::Control::Request;

use Digest::SHA qw(hmac_sha1_hex);
use JSON::XS ();
use URI       ();

# ---------------------------------------------------------------------------
# Initialisation
# ---------------------------------------------------------------------------

my $log = Slim::Utils::Log->addLogCategory({
    category     => 'plugin.alexabridge',
    defaultLevel => 'DEBUG',
    description  => 'Alexa Bridge Plugin',
});

my $prefs = preferences('plugin.alexabridge');

# ---------------------------------------------------------------------------
# Shadow state – mirrors what Alexa AudioPlayer is currently doing so that
# anything that queries LMS can see what's playing via Alexa.
# Updated by Lambda via GET /alexa/playback; read via /alexa/playback/current.
# ---------------------------------------------------------------------------

my %_alexa_state = (
    state   => 'stopped',   # stopped | playing | paused
    trackId => undef,       # LMS track DB id (integer) or undef
    offsetMs => 0,          # offsetInMilliseconds
    updated  => 0,          # epoch time of last update
);

$prefs->init({
    secret    => '',       # Shared secret – set this in plugin settings
    token_ttl => 86400,    # Signed stream URL lifetime in seconds (default 24 h)
});

sub initPlugin {
    my ( $class, %args ) = @_;
    $class->SUPER::initPlugin(%args);

    # Register settings page
    if ( main::WEBUI ) {
        require Plugins::AlexaBridge::Settings;
        Plugins::AlexaBridge::Settings->new($class);
    }

    # Register raw HTTP handler for all /alexa/* paths
    Slim::Web::Pages->addRawFunction( qr{^/alexa/}, \&_dispatch );
    # Human-friendly status page in LMS web UI
    Slim::Web::Pages->addRawFunction( qr{^/plugins/alexabridge/status/?$}, \&_statusPage );

    $log->info('AlexaBridge plugin initialised');
}

# ---------------------------------------------------------------------------
# Request dispatcher
# ---------------------------------------------------------------------------

sub _dispatch {
    my ( $httpClient, $httpResponse ) = @_;

    my $request = $httpResponse->request;
    my $uri     = URI->new( 'http://localhost' . $request->uri );
    my $path    = $uri->path;
    my %params  = $uri->query_form;

    $log->debug("AlexaBridge request: $path");

    # Stream endpoint uses its own per-URL HMAC – handled inside _streamTrack
    unless ( $path =~ m{^/alexa/stream/} ) {
        unless ( _validateApiToken( $params{token} ) ) {
            return _sendError( $httpClient, $httpResponse, 401, 'Unauthorized' );
        }
    }

    if    ( $path =~ m{^/alexa/search$} )                  { _search(          $httpClient, $httpResponse, \%params ) }
    elsif ( $path =~ m{^/alexa/album/(\d+)/tracks$} )      { _albumTracks(     $httpClient, $httpResponse, $1, \%params ) }
    elsif ( $path =~ m{^/alexa/track/(\d+)$} )             { _track(           $httpClient, $httpResponse, $1 ) }
    elsif ( $path =~ m{^/alexa/nowplaying$} )              { _nowPlaying(      $httpClient, $httpResponse, \%params ) }
    elsif ( $path =~ m{^/alexa/control$} )                 { _control(         $httpClient, $httpResponse, \%params ) }
    elsif ( $path =~ m{^/alexa/players$} )                 { _players(         $httpClient, $httpResponse ) }
    elsif ( $path =~ m{^/alexa/stream/(\d+)$} )            { _streamTrack(     $httpClient, $httpResponse, $1, \%params ) }
    elsif ( $path =~ m{^/alexa/playback/current$} )        { _playbackCurrent( $httpClient, $httpResponse ) }
    elsif ( $path =~ m{^/alexa/playback$} )                { _playbackUpdate(  $httpClient, $httpResponse, \%params ) }
    else                                                   { _sendError(       $httpClient, $httpResponse, 404, 'Not found' ) }
}

# ---------------------------------------------------------------------------
# Endpoint handlers
# ---------------------------------------------------------------------------

# GET /alexa/search?q=<query>&type=track|album|artist&token=<t>
#
# Returns up to 20 results.  Track and album results include signed stream
# URLs that can be passed directly to Alexa AudioPlayer.
sub _search {
    my ( $httpClient, $httpResponse, $p ) = @_;

    my $q    = $p->{q}    // '';
    my $type = $p->{type} // 'track';

    my @results;

    if ( $type eq 'track' ) {
        my $rs = Slim::Schema->search( 'Track',
            { title => { like => "%$q%" } },
            { rows => 20, order_by => 'title' },
        );
        while ( my $track = $rs->next ) {
            push @results, _trackData($track);
        }

    } elsif ( $type eq 'album' ) {
        my $rs = Slim::Schema->search( 'Album',
            { title => { like => "%$q%" } },
            { rows => 20, order_by => 'title' },
        );
        while ( my $album = $rs->next ) {
            push @results, {
                id     => $album->id + 0,
                title  => $album->title,
                artist => $album->contributor ? $album->contributor->name : '',
                year   => $album->year // undef,
            };
        }

    } elsif ( $type eq 'artist' ) {
        my $rs = Slim::Schema->search( 'Contributor',
            { name => { like => "%$q%" } },
            { rows => 20, order_by => 'name' },
        );
        while ( my $artist = $rs->next ) {
            push @results, {
                id   => $artist->id + 0,
                name => $artist->name,
            };
        }
    }

    _sendJSON( $httpClient, $httpResponse, { results => \@results } );
}

# GET /alexa/album/<album_id>/tracks?token=<t>
#
# Returns all tracks in an album in track-number order.
# Use this to build the Alexa AudioPlayer queue for an album.
sub _albumTracks {
    my ( $httpClient, $httpResponse, $albumId, $p ) = @_;

    my $album = Slim::Schema->find( 'Album', $albumId );
    unless ($album) {
        return _sendError( $httpClient, $httpResponse, 404, 'Album not found' );
    }

    my @tracks =
        map  { _trackData($_) }
        sort { ( $a->tracknum // 0 ) <=> ( $b->tracknum // 0 ) }
        $album->tracks->all;

    _sendJSON( $httpClient, $httpResponse, {
        album  => {
            id     => $album->id + 0,
            title  => $album->title,
            artist => $album->contributor ? $album->contributor->name : '',
            year   => $album->year // undef,
        },
        tracks => \@tracks,
    });
}

# GET /alexa/nowplaying?player=<id>&token=<t>
#
# Returns current track info and an artwork URL suitable for Echo Show APL.
# Artwork is served at /music/<track_id>/cover.jpg by LMS.
sub _nowPlaying {
    my ( $httpClient, $httpResponse, $p ) = @_;

    my $client = _findPlayer( $p->{player} )
        or return _sendError( $httpClient, $httpResponse, 404, 'Player not found' );

    my $song = Slim::Player::Playlist::song($client);

    my $data = {
        player_id  => $client->id,
        name       => $client->name,
        is_playing => $client->isPlaying ? JSON::XS::true : JSON::XS::false,
        volume     => $client->volume + 0,
        track      => $song ? _trackData($song) : undef,
    };

    _sendJSON( $httpClient, $httpResponse, $data );
}

# GET /alexa/control?player=<id>&cmd=pause|resume|next|prev|volume|stop&value=<v>&token=<t>
#
# Sends a playback command to an LMS player.
# For 'volume', pass value=0..100.
sub _control {
    my ( $httpClient, $httpResponse, $p ) = @_;

    my $client = _findPlayer( $p->{player} )
        or return _sendError( $httpClient, $httpResponse, 404, 'Player not found' );

    my $cmd   = $p->{cmd}   // '';
    my $value = $p->{value};

    my %dispatch = (
        pause  => sub { Slim::Control::Request::executeRequest( $client, ['pause',    1      ] ) },
        resume => sub { Slim::Control::Request::executeRequest( $client, ['pause',    0      ] ) },
        next   => sub { Slim::Control::Request::executeRequest( $client, ['playlist', 'index', '+1'] ) },
        prev   => sub { Slim::Control::Request::executeRequest( $client, ['playlist', 'index', '-1'] ) },
        stop   => sub { Slim::Control::Request::executeRequest( $client, ['stop'              ] ) },
        volume => sub {
            my $vol = int( $value // 50 );
            $vol = 0   if $vol < 0;
            $vol = 100 if $vol > 100;
            Slim::Control::Request::executeRequest( $client, ['mixer', 'volume', $vol] );
        },
    );

    if ( my $handler = $dispatch{$cmd} ) {
        $handler->();
        _sendJSON( $httpClient, $httpResponse, { ok => JSON::XS::true, cmd => $cmd } );
    } else {
        _sendError( $httpClient, $httpResponse, 400, "Unknown command: $cmd" );
    }
}

# GET /alexa/players?token=<t>
#
# Lists all connected LMS players.  Use this to discover the player ID to
# target (set as LMS_PLAYER_ID in your Lambda environment variables).
sub _players {
    my ( $httpClient, $httpResponse ) = @_;

    my @players = map {
        {
            id        => $_->id,
            name      => $_->name,
            model     => $_->model,
            connected => $_->connected ? JSON::XS::true : JSON::XS::false,
        }
    } Slim::Player::Client::clients();

    _sendJSON( $httpClient, $httpResponse, { players => \@players } );
}

# GET /alexa/stream/<track_id>?exp=<unix_ts>&sig=<hmac>
#
# Validates the per-URL HMAC signature and expiry, then 302-redirects to
# LMS's native /music/<id>/download endpoint.
#
# These URLs are generated by _signedStreamUrl() and embedded in search /
# album responses.  Alexa AudioPlayer follows the redirect transparently.
sub _streamTrack {
    my ( $httpClient, $httpResponse, $trackId, $p ) = @_;

    my $exp = $p->{exp} // 0;
    my $sig = $p->{sig} // '';

    if ( time() > $exp ) {
        return _sendError( $httpClient, $httpResponse, 403, 'Stream URL expired' );
    }

    my $secret   = $prefs->get('secret');
    my $expected = hmac_sha1_hex( "stream:${trackId}:${exp}", $secret );
    unless ( _constTimeEq( $sig, $expected ) ) {
        return _sendError( $httpClient, $httpResponse, 403, 'Invalid signature' );
    }

    my $track = Slim::Schema->find( 'Track', $trackId );
    unless ($track) {
        return _sendError( $httpClient, $httpResponse, 404, 'Track not found' );
    }

    # Redirect to LMS native audio stream
    $httpResponse->code(302);
    $httpResponse->header( Location => "/music/${trackId}/download" );
    $httpClient->send_response($httpResponse);
    Slim::Web::HTTP::closeHTTPSocket($httpClient);
}

# GET /alexa/playback?state=playing|paused|stopped&trackId=<id>&offsetMs=<ms>&token=<t>
#
# Called by Lambda whenever the Alexa AudioPlayer state changes.  Updates the
# in-memory shadow state so /alexa/playback/current always reflects reality.
sub _playbackUpdate {
    my ( $httpClient, $httpResponse, $p ) = @_;

    my $state = $p->{state} // 'stopped';
    unless ( $state =~ m{^(playing|paused|stopped)$} ) {
        return _sendError( $httpClient, $httpResponse, 400, 'Invalid state' );
    }

    my $trackId  = $p->{trackId}  ? $p->{trackId}  + 0 : undef;
    my $offsetMs = $p->{offsetMs} ? $p->{offsetMs} + 0 : 0;

    %_alexa_state = (
        state    => $state,
        trackId  => $trackId,
        offsetMs => $offsetMs,
        updated  => time(),
    );

    $log->debug("Alexa shadow state updated: state=$state trackId=" . ($trackId // 'none') . " offsetMs=$offsetMs");

    _sendJSON( $httpClient, $httpResponse, { ok => JSON::XS::true, state => $state } );
}

# GET /alexa/playback/current?token=<t>
#
# Returns the current Alexa shadow playback state, including full track
# metadata when a trackId is available.
sub _playbackCurrent {
    my ( $httpClient, $httpResponse ) = @_;

    my $trackId = $_alexa_state{trackId};
    my $track   = undef;

    if ( defined $trackId ) {
        my $t = Slim::Schema->find( 'Track', $trackId );
        $track = $t ? _trackData($t) : undef;
    }

    _sendJSON( $httpClient, $httpResponse, {
        state    => $_alexa_state{state},
        trackId  => $trackId,
        offsetMs => $_alexa_state{offsetMs} + 0,
        updated  => $_alexa_state{updated}  + 0,
        track    => $track,
    });
}

# GET /plugins/alexabridge/status
#
# Simple human-readable LMS page showing current Alexa shadow state.
sub _statusPage {
    my ( $httpClient, $httpResponse ) = @_;

    my $trackId = $_alexa_state{trackId};
    my $track;
    if ( defined $trackId ) {
        my $t = Slim::Schema->find( 'Track', $trackId );
        $track = $t ? _trackData($t) : undef;
    }

    my $state    = _escapeHtml( $_alexa_state{state} // 'stopped' );
    my $offsetMs = int( $_alexa_state{offsetMs} // 0 );
    my $updated  = int( $_alexa_state{updated}  // 0 );

    my $title  = _escapeHtml( $track ? ( $track->{title}  // '' ) : '' );
    my $artist = _escapeHtml( $track ? ( $track->{artist} // '' ) : '' );
    my $album  = _escapeHtml( $track ? ( $track->{album}  // '' ) : '' );

    my $when = $updated ? scalar localtime($updated) : 'never';
    my $body = "";
    $body .= qq{<!doctype html>\n};
    $body .= qq{<html><head><meta charset="utf-8">};
    $body .= qq{<meta http-equiv="refresh" content="5">};
    $body .= qq{<title>Alexa Bridge Status</title>};
    $body .= qq{<style>body{font-family:Arial,sans-serif;margin:24px;line-height:1.45;color:#222}h1{margin:0 0 12px}code{background:#f2f2f2;padding:2px 6px;border-radius:4px}.card{border:1px solid #ddd;border-radius:8px;padding:14px;max-width:780px}.meta{color:#555;margin-top:8px}</style>};
    $body .= qq{</head><body>};
    $body .= qq{<h1>Alexa Bridge Status</h1>};
    $body .= qq{<div class="card">};
    $body .= qq{<div><strong>State:</strong> <code>$state</code></div>};
    $body .= qq{<div><strong>Track ID:</strong> <code>} . ( defined $trackId ? int($trackId) : 'none' ) . qq{</code></div>};
    $body .= qq{<div><strong>Offset:</strong> <code>$offsetMs ms</code></div>};
    if ($track) {
        $body .= qq{<div style="margin-top:10px"><strong>Now playing on Alexa</strong></div>};
        $body .= qq{<div>Title: $title</div>};
        $body .= qq{<div>Artist: $artist</div>};
        $body .= qq{<div>Album: $album</div>};
    } else {
        $body .= qq{<div style="margin-top:10px">No track metadata cached yet.</div>};
    }
    $body .= qq{<div class="meta">Last update: $when</div>};
    $body .= qq{<div class="meta"><a href="/plugins/alexabridge/status">Refresh now</a></div>};
    $body .= qq{</div></body></html>};

    $httpResponse->code(200);
    $httpResponse->content_type('text/html; charset=utf-8');
    $httpResponse->header( 'Cache-Control' => 'no-store' );
    $httpResponse->content($body);
    $httpClient->send_response($httpResponse);
    Slim::Web::HTTP::closeHTTPSocket($httpClient);
}

# GET /alexa/track/<id>
#
# Returns metadata for a single track by its LMS database ID.
sub _track {
    my ( $httpClient, $httpResponse, $trackId ) = @_;

    my $track = Slim::Schema->find( 'Track', $trackId );
    unless ($track) {
        return _sendError( $httpClient, $httpResponse, 404, 'Track not found' );
    }

    _sendJSON( $httpClient, $httpResponse, _trackData($track) );
}

# ---------------------------------------------------------------------------
# Helper: build track data hash (shared by search, album, nowplaying)
# ---------------------------------------------------------------------------

sub _trackData {
    my ($track) = @_;
    return {
        id       => $track->id + 0,
        title    => $track->title   // '',
        artist   => $track->artistName // '',
        album    => $track->album ? $track->album->title : '',
        tracknum => $track->tracknum ? $track->tracknum + 0 : undef,
        duration => $track->secs    ? $track->secs + 0      : undef,
        # stream_url is a path; Lambda must prepend LMS_BASE_URL
        stream_url => _signedStreamUrl( $track->id ),
        # artwork_url is a path; Lambda must prepend LMS_BASE_URL
        # Served by LMS natively – no signing required
        artwork_url => '/music/' . $track->id . '/cover.jpg',
    };
}

# ---------------------------------------------------------------------------
# Helper: authentication
# ---------------------------------------------------------------------------

# Validates the static API token sent with every non-stream request.
# Token = HMAC-SHA1('api', secret).  Pre-compute with:
#   perl -MDigest::HMAC_SHA1=hmac_sha1_hex -e 'print hmac_sha1_hex("api","YOUR_SECRET")'
# Store the result as LMS_API_TOKEN in your Lambda environment.
sub _validateApiToken {
    my ($token) = @_;
    return 0 unless defined $token && length $token;
    my $secret = $prefs->get('secret');
    return 0 unless $secret;
    my $expected = hmac_sha1_hex( 'api', $secret );
    return _constTimeEq( $token, $expected );
}

# Generates a signed, expiring URL path for a single track stream.
# Lambda prepends LMS_BASE_URL before sending to Alexa AudioPlayer.
sub _signedStreamUrl {
    my ($trackId) = @_;
    my $secret = $prefs->get('secret');
    my $exp    = time() + ( $prefs->get('token_ttl') // 86400 );
    my $sig    = hmac_sha1_hex( "stream:${trackId}:${exp}", $secret );
    return "/alexa/stream/${trackId}?exp=${exp}&sig=${sig}";
}

# Constant-time string comparison – prevents timing-based token guessing
sub _constTimeEq {
    my ( $a, $b ) = @_;
    return 0 if length($a) != length($b);
    my $diff = 0;
    $diff |= ord( substr( $a, $_, 1 ) ) ^ ord( substr( $b, $_, 1 ) )
        for 0 .. length($a) - 1;
    return $diff == 0;
}

sub _escapeHtml {
    my ($s) = @_;
    $s = '' unless defined $s;
    $s =~ s/&/&amp;/g;
    $s =~ s/</&lt;/g;
    $s =~ s/>/&gt;/g;
    $s =~ s/"/&quot;/g;
    $s =~ s/'/&#39;/g;
    return $s;
}

# ---------------------------------------------------------------------------
# Helper: player lookup
# ---------------------------------------------------------------------------

sub _findPlayer {
    my ($id) = @_;
    return undef unless defined $id && length $id;
    return Slim::Player::Client::getClient($id);
}

# ---------------------------------------------------------------------------
# Helper: HTTP responses
# ---------------------------------------------------------------------------

sub _sendJSON {
    my ( $httpClient, $httpResponse, $data ) = @_;
    my $body = JSON::XS->new->utf8->encode($data);
    $httpResponse->code(200);
    $httpResponse->content_type('application/json; charset=utf-8');
    $httpResponse->header( 'Cache-Control' => 'no-store' );
    $httpResponse->content($body);
    $httpClient->send_response($httpResponse);
    Slim::Web::HTTP::closeHTTPSocket($httpClient);
}

sub _sendError {
    my ( $httpClient, $httpResponse, $code, $message ) = @_;
    my $body = JSON::XS->new->utf8->encode({ error => $message });
    $httpResponse->code($code);
    $httpResponse->content_type('application/json; charset=utf-8');
    $httpResponse->header( 'Cache-Control' => 'no-store' );
    $httpResponse->content($body);
    $httpClient->send_response($httpResponse);
    Slim::Web::HTTP::closeHTTPSocket($httpClient);
}

1;
