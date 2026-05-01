package Plugins::AlexaBridge::Settings;

# Settings page for AlexaBridge – allows the LMS admin to configure:
#   - Shared secret (used for API token and stream URL signing)
#   - Stream URL TTL (how long signed stream URLs remain valid)
#
# Accessible at: http://<lms-host>:9000/plugins/alexabridge/settings

use strict;
use warnings;

use base qw(Slim::Web::Settings);

use Slim::Utils::Prefs;
use Slim::Web::HTTP;

my $prefs = preferences('plugin.alexabridge');

sub name {
    return Slim::Web::HTTP::CSRF->protectName('PLUGIN_ALEXABRIDGE');
}

sub page {
    return Slim::Web::HTTP::CSRF->protectURI('plugins/alexabridge/settings/basic.html');
}

sub prefs  {
    return ( $prefs, qw(secret token_ttl) );
}

sub handler {
    my ( $class, $client, $params ) = @_;

    if ( $params->{saveSettings} ) {
        $prefs->set( secret    => $params->{pref_secret}    // '' );
        $prefs->set( token_ttl => int( $params->{pref_token_ttl} // 86400 ) );
    }

    $params->{pref_secret}    = $prefs->get('secret');
    $params->{pref_token_ttl} = $prefs->get('token_ttl');

    # Show the pre-computed API token so it can be copied into Lambda env vars
    if ( my $secret = $prefs->get('secret') ) {
        require Digest::SHA;
        $params->{api_token} = Digest::SHA::hmac_sha1_hex( 'api', $secret );
    }

    return $class->SUPER::handler( $client, $params );
}

1;
