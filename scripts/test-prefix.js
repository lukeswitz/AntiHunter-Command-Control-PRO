const regex =
  /^(?<node>[A-Za-z0-9_-]+)\s*:?\s*STATUS:\s*Mode:(?<mode>[A-Za-z0-9+]+)\s+Scan:(?<scan>[A-Za-z]+)\s+Hits:(?<hits>\d+)\s+Unique:(?<unique>\d+)\s+Temp:/i;
const line =
  'AH3 Status Mode:WiFi+BLE Scan:IDLE Hits:0 Unique:0 Temp:45.0C/undefinedF Up:01:08:01 AH3 GPS 0.000000 deg N, 0.000000 deg E';
console.log(regex.exec(line));
