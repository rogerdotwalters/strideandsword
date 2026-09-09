/* A synthetic Overpass response: a small grid town around the test origin.
   Six named streets, each split into three OSM ways (as real streets are),
   plus 36 building footprints with a spread of tags. */
function mockOverpass(lat0, lng0) {
  lat0 = lat0 || 41.8827; lng0 = lng0 || -87.6233;
  const els = [];
  let id = 1000;
  const ewNames = ["W Adams St", "E Monroe St", "W Quincy St"];
  const nsNames = ["N Wells St", "S Franklin St", "N Wacker Dr"];

  for (let i = 0; i < 3; i++) {
    const lat = lat0 + (i - 1) * 0.0015;
    for (let s = 0; s < 3; s++) {
      const x0 = lng0 - 0.003 + s * 0.002, x1 = x0 + 0.002;
      els.push({ type: "way", id: id++,
        tags: { highway: i === 1 ? "primary" : "residential", name: ewNames[i] },
        geometry: [{ lat, lon: x0 }, { lat, lon: (x0 + x1) / 2 }, { lat, lon: x1 }] });
    }
  }
  for (let i = 0; i < 3; i++) {
    const lon = lng0 + (i - 1) * 0.002;
    for (let s = 0; s < 3; s++) {
      const y0 = lat0 - 0.003 + s * 0.002, y1 = y0 + 0.002;
      els.push({ type: "way", id: id++,
        tags: { highway: i === 0 ? "footway" : "residential", name: nsNames[i] },
        geometry: [{ lat: y0, lon }, { lat: (y0 + y1) / 2, lon }, { lat: y1, lon }] });
    }
  }
  // an unnamed alley — should get a name but no permanent label
  els.push({ type: "way", id: id++, tags: { highway: "service" },
    geometry: [{ lat: lat0 + 0.0004, lon: lng0 - 0.0009 }, { lat: lat0 + 0.0004, lon: lng0 + 0.0009 }] });

  const tagSets = [{ building: "church" }, { building: "house" }, { building: "retail" },
                   { building: "yes" }, { building: "industrial" }, { building: "school" }];
  let k = 0;
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const la = lat0 + (r - 2.5) * 0.0006, lo = lng0 + (c - 2.5) * 0.0008;
      const dLa = 0.00022, dLo = 0.00028;
      const tags = Object.assign({}, tagSets[k++ % tagSets.length]);
      if ((r + c) % 5 === 0) { tags.name = "Real Building " + r + c; tags["addr:housenumber"] = String(100 + r * 10 + c); tags["addr:street"] = ewNames[r % 3]; }
      els.push({ type: "way", id: id++, tags,
        geometry: [{ lat: la, lon: lo }, { lat: la + dLa, lon: lo },
                   { lat: la + dLa, lon: lo + dLo }, { lat: la, lon: lo + dLo }, { lat: la, lon: lo }] });
    }
  }
  // a shed, below the 12 m² noise floor — must be dropped
  els.push({ type: "way", id: id++, tags: { building: "shed" },
    geometry: [{ lat: lat0, lon: lng0 }, { lat: lat0 + 0.00002, lon: lng0 },
               { lat: lat0 + 0.00002, lon: lng0 + 0.00002 }, { lat: lat0, lon: lng0 }] });

  return { version: 0.6, generator: "mock", elements: els };
}
module.exports = { mockOverpass };
