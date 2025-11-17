const regex =
  /^(?:[A-Za-z0-9_-]+\s+)?GPS(?:[:=]\s*|\s+)(?<gpsLat>-?\d+(?:\.\d+)?)(?:\s*(?:deg)?\s*[NnSs])?,\s*(?<gpsLon>-?\d+(?:\.\d+)?)(?:\s*(?:deg)?\s*[EeWw])?/i;
const segment = 'AH3 GPS 0.000000 deg N, 0.000000 deg E';
console.log(regex.exec(segment));
