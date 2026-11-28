#!/bin/sh
set -eu
test -f "$PEER_AGENT_HOME/.prediction-credential-fixture"

request=
IFS= read -r request || [ -n "$request" ] || exit 1
printf '%s' "$request" > "$PEER_AGENT_HOME/lookup-request.json"
: > "$PEER_AGENT_HOME/lookup-started"
while [ ! -f "$PEER_AGENT_HOME/lookup-release" ]; do
  sleep 0.01
done
printf '%s' '{"version":1,"ok":true,"data":{"secret":"worker-test-secret"}}'
