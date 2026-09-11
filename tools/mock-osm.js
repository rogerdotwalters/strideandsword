/* A synthetic Overpass response: a small grid town around the test origin.
   Six named streets, each split into three OSM ways (as real streets are),
   36 building footprints with a spread of tags, and a set of public places —
   two parks as polygons, food and civic POIs both as their own buildings and
   as bare nodes — so the spawn weighting has real categories to sort. */
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
  /* ---- public places ----
     Two parks as rings, because a park carries no building tag and has to come
     through as an area. One sits north-west of the origin, one south-east, so
     a test can assert which one a spawn picked. */
  const park = (cLat, cLng, dLat, dLng, tags) => {
    els.push({ type: "way", id: id++, tags,
      geometry: [
        { lat: cLat - dLat, lon: cLng - dLng }, { lat: cLat + dLat, lon: cLng - dLng },
        { lat: cLat + dLat, lon: cLng + dLng }, { lat: cLat - dLat, lon: cLng + dLng },
        { lat: cLat - dLat, lon: cLng - dLng }
      ] });
  };
  park(lat0 + 0.0018, lng0 - 0.0022, 0.0007, 0.0009, { leisure: "park", name: "Test Park North" });
  park(lat0 - 0.0016, lng0 + 0.0020, 0.0005, 0.0007, { leisure: "recreation_ground", name: "Test Rec Ground" });
  // a playground with no name, to prove an unnamed place still gets one
  park(lat0 + 0.0006, lng0 + 0.0024, 0.0002, 0.0003, { leisure: "playground" });

  /* Food: one as its own building way (the common supermarket case), one as a
     bare node inside a shell (the common cafe case). */
  els.push({ type: "way", id: id++,
    tags: { building: "retail", shop: "supermarket", name: "Test Grocer" },
    geometry: [
      { lat: lat0 - 0.0009, lon: lng0 - 0.0014 }, { lat: lat0 - 0.0005, lon: lng0 - 0.0014 },
      { lat: lat0 - 0.0005, lon: lng0 - 0.0008 }, { lat: lat0 - 0.0009, lon: lng0 - 0.0008 },
      { lat: lat0 - 0.0009, lon: lng0 - 0.0014 }
    ] });
  els.push({ type: "node", id: id++, lat: lat0 + 0.0011, lon: lng0 + 0.0009,
             tags: { amenity: "cafe", name: "Test Cafe" } });
  els.push({ type: "node", id: id++, lat: lat0 - 0.0012, lon: lng0 - 0.0004,
             tags: { amenity: "fast_food" } });

  /* Civic and transit, so every category in the weights file is represented. */
  els.push({ type: "node", id: id++, lat: lat0 + 0.0014, lon: lng0 + 0.0016,
             tags: { amenity: "library", name: "Test Library" } });
  els.push({ type: "node", id: id++, lat: lat0 - 0.0020, lon: lng0 - 0.0018,
             tags: { amenity: "parking" } });

  // a shed, below the 12 m² noise floor — must be dropped
  els.push({ type: "way", id: id++, tags: { building: "shed" },
    geometry: [{ lat: lat0, lon: lng0 }, { lat: lat0 + 0.00002, lon: lng0 },
               { lat: lat0 + 0.00002, lon: lng0 + 0.00002 }, { lat: lat0, lon: lng0 }] });

  return { version: 0.6, generator: "mock", elements: els };
}
module.exports = { mockOverpass };
