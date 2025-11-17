const regex =
  /^(?<node>[A-Za-z0-9_-]+):\s*GPS(?:[:=]\s*|\s+)(?<lat>-?\d+(?:\.\d+)?)\s*,\s*(?<lon>-?\d+(?:\.\d+)?)/i;
console.log(regex.exec('AH3 GPS:0.000000, 0.000000'));
