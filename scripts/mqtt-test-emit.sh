#!/usr/bin/env bash
set -euo pipefail

HOST="${MQTT_HOST:-broker.emqx.io}"
PORT="${MQTT_PORT:-1883}"
SITE="${MQTT_SITE:-bravo}"
TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

AUTH=()
[ -n "${MQTT_USER:-}" ] && AUTH+=(-u "$MQTT_USER")
[ -n "${MQTT_PASS:-}" ] && AUTH+=(-P "$MQTT_PASS")
TLS=()
[ "${MQTT_TLS:-0}" = "1" ] && TLS+=(--capath /etc/ssl/certs)

pub() {
  local topic="$1" body="$2"
  mosquitto_pub -h "$HOST" -p "$PORT" "${AUTH[@]}" "${TLS[@]}" -q 0 -t "$topic" -m "$body"
  echo "-> $topic"
}

pub "ahcc/$SITE/nodes/upsert" '{"type":"node.upsert","originSiteId":"'"$SITE"'","payload":{"id":"digi","name":"digi","lat":null,"lon":null,"ts":"'"$TS"'","lastMessage":"digi battery:101% voltage:4.20V uptime:366s","lastSeen":"'"$TS"'","siteId":"'"$SITE"'","siteName":"BRAVO","siteColor":"#00c7fc","siteCountry":null,"siteCity":null,"temperatureC":null,"temperatureF":null,"temperatureUpdatedAt":null}}'

pub "ahcc/$SITE/inventory/upsert" '{"type":"inventory.upsert","originSiteId":"'"$SITE"'","payload":{"mac":"AA:BB:CC:DD:EE:FF","siteId":"'"$SITE"'","vendor":"Espressif","type":"probe","ssid":"HomeNet","hits":12,"lastSeen":"'"$TS"'","maxRSSI":-42,"minRSSI":-88,"avgRSSI":-65,"locallyAdministered":false,"multicast":false,"lastNodeId":"digi","lastLat":null,"lastLon":null,"channel":6,"createdAt":"'"$TS"'","updatedAt":"'"$TS"'"}}'

pub "ahcc/$SITE/targets/upsert" '{"type":"target.upsert","originSiteId":"'"$SITE"'","payload":{"id":"tgt-001","name":"Suspect Phone","mac":"11:22:33:44:55:66","lat":37.7749,"lon":-122.4194,"url":null,"notes":"seen near gate","tags":["watchlist"],"siteId":"'"$SITE"'","createdBy":"admin","deviceType":"phone","firstNodeId":"digi","status":"ACTIVE","createdAt":"'"$TS"'","updatedAt":"'"$TS"'"}}'

pub "ahcc/$SITE/targets/delete" '{"type":"target.delete","originSiteId":"'"$SITE"'","targetId":"tgt-001"}'

pub "ahcc/$SITE/geofences/upsert" '{"type":"geofence.upsert","originSiteId":"'"$SITE"'","payload":{"id":"gf-001","siteId":"'"$SITE"'","originSiteId":"'"$SITE"'","name":"Perimeter","description":"main fence","color":"#ff0000","polygon":[[37.77,-122.42],[37.78,-122.42],[37.78,-122.41],[37.77,-122.41]],"alarmEnabled":true,"alarmLevel":"warning","alarmMessage":"Breach detected","alarmTriggerOnExit":false,"appliesToAdsb":false,"appliesToDrones":true,"appliesToTargets":true,"createdBy":"admin","createdAt":"'"$TS"'","updatedAt":"'"$TS"'","site":{"id":"'"$SITE"'","name":"BRAVO","color":"#00c7fc","country":null,"city":null}}}'

pub "ahcc/$SITE/geofences/delete" '{"type":"geofence.delete","originSiteId":"'"$SITE"'","geofenceId":"gf-001"}'

pub "ahcc/$SITE/geofences/snapshot" '{"type":"geofence.snapshot","originSiteId":"'"$SITE"'","generatedAt":"'"$TS"'","geofences":[{"id":"gf-001","siteId":"'"$SITE"'","originSiteId":"'"$SITE"'","name":"Perimeter","description":"main fence","color":"#ff0000","polygon":[[37.77,-122.42],[37.78,-122.42],[37.78,-122.41],[37.77,-122.41]],"alarmEnabled":true,"alarmLevel":"warning","alarmMessage":"Breach detected","alarmTriggerOnExit":false,"appliesToAdsb":false,"appliesToDrones":true,"appliesToTargets":true,"createdBy":"admin","createdAt":"'"$TS"'","updatedAt":"'"$TS"'","site":{"id":"'"$SITE"'","name":"BRAVO","color":"#00c7fc","country":null,"city":null}}]}'

pub "ahcc/$SITE/drones/upsert" '{"type":"drone.upsert","originSiteId":"'"$SITE"'","payload":{"id":"drn-001","droneId":"DRN123","mac":null,"nodeId":"digi","siteId":"'"$SITE"'","siteName":"BRAVO","siteColor":"#00c7fc","siteCountry":null,"siteCity":null,"lat":37.7749,"lon":-122.4194,"altitude":120,"speed":15,"operatorLat":37.774,"operatorLon":-122.418,"rssi":-70,"status":"active","lastSeen":"'"$TS"'","ts":"'"$TS"'","faa":null}}'

pub "ahcc/$SITE/events/event-alert" '{"type":"event.broadcast","originSiteId":"'"$SITE"'","eventType":"event.alert","payload":{"type":"event.alert","id":"alert-001","siteId":"'"$SITE"'","nodeId":"digi","message":"Motion detected","level":"warning","timestamp":"'"$TS"'","data":{"rssi":-55}}}'

pub "ahcc/$SITE/events/drone-telemetry" '{"type":"event.broadcast","originSiteId":"'"$SITE"'","eventType":"drone.telemetry","payload":{"type":"drone.telemetry","siteId":"'"$SITE"'","droneId":"DRN123","mac":null,"nodeId":"digi","siteName":"BRAVO","lat":37.7749,"lon":-122.4194,"altitude":120,"speed":15,"operatorLat":37.774,"operatorLon":-122.418,"rssi":-70,"timestamp":"'"$TS"'","status":"active"}}'

pub "ahcc/$SITE/events/drone-status" '{"type":"event.broadcast","originSiteId":"'"$SITE"'","eventType":"drone.status","payload":{"type":"drone.status","siteId":"'"$SITE"'","droneId":"DRN123","status":"lost"}}'

pub "ahcc/$SITE/commands/events" '{"type":"command.event","originSiteId":"'"$SITE"'","commandId":"cmd-001","payload":{"siteId":"'"$SITE"'","status":"completed","target":"digi","name":"scan","params":["wifi","60"],"userId":"admin","ackKind":"ack","ackStatus":"ok","ackNode":"digi","resultText":"scan complete","errorText":null,"createdAt":"'"$TS"'","startedAt":"'"$TS"'","finishedAt":"'"$TS"'","timestamp":"'"$TS"'"}}'

pub "ahcc/$SITE/commands/request" '{"type":"command.request","originSiteId":"alpha","targetSiteId":"'"$SITE"'","commandId":"cmd-002","payload":{"target":"digi","name":"scan","params":["ble","30"],"line":"scan ble 30","userId":"admin"}}'

pub "ahcc/$SITE/chat" '{"type":"chat.message","id":"11111111-1111-1111-1111-111111111111","siteId":"'"$SITE"'","originSiteId":"'"$SITE"'","fromUserId":"u1","fromEmail":"operator@ahcc.local","fromRole":"ADMIN","fromDisplayName":"Operator","encrypted":false,"text":"test message","ts":"'"$TS"'"}'

pub "ahcc/$SITE/chat" '{"type":"chat.clear","originSiteId":"'"$SITE"'","target":"all","ts":"'"$TS"'"}'

echo "done: 15 messages to $HOST:$PORT site=$SITE"
