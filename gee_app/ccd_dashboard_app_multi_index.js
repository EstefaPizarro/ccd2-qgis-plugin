// CCD 2.0 - Point Dashboard (Google Earth Engine App)
// Dropdown to switch the chart + map color composite between NDVI/EVI/NBR/NBI.
//
// Not run from Python - paste this into code.earthengine.google.com, run it once to
// preview, then Apps > Publish new App.
//
// Band-prep/index formulas below mirror CCD_Plugin/core/gee_data_sentinel.py (NDVI/NBR/EVI
// - same scale factors, same band names). NBI (here: NDBI, the built-up index) has no
// equivalent in that Python file.
//
// Scope: Sentinel-2 + Landsat 8 only (2015-present) - Landsat 5/7 were dropped for speed
// and simplicity (L5 retired 2013, no data since; L7 removed to keep this to 2 sensors).

var HISTORY_START = '2015-01-01';

var geoJsonParam = ui.url.get('geoJson', null);
var parsed = geoJsonParam ? JSON.parse(geoJsonParam) : {type: 'Point', coordinates: [-70.6483, -33.4569]};
var geom = ee.Geometry(parsed);

// Client-side centroid (average of the ring/point) - avoids a slow getInfo() round-trip
// just to center the maps and label the title.
var ring = parsed.type === 'Polygon' ? parsed.coordinates[0] : [parsed.coordinates];
var lon = ring.reduce(function (s, c) { return s + c[0]; }, 0) / ring.length;
var lat = ring.reduce(function (s, c) { return s + c[1]; }, 0) / ring.length;
var point = ee.Geometry.Point([lon, lat]);

var thisYear = new Date().getFullYear();
var MAP_HEIGHT = '350px'; // ui.Map() has no default height - without this it renders invisible

// Low(red) -> high(green) diverging palette, shared by NDVI/EVI/NBR (all "low=bad,
// high=good" on a -1..1 scale). NBI reuses it reversed - high NDBI (built-up) should read
// red, not green.
var DIVERGING_PALETTE = ['a50026', 'f46d43', 'ffffbf', '66bd63', '1a9850'];
var INDEX_CONFIGS = {
  NDVI: {min: -1, max: 1, palette: DIVERGING_PALETTE},
  EVI: {min: -1, max: 1, palette: DIVERGING_PALETTE},
  NBR: {min: -1, max: 1, palette: DIVERGING_PALETTE},
  NBI: {min: -1, max: 1, palette: DIVERGING_PALETTE.slice().reverse()},
};
var INDEX_NAMES = ['NDVI', 'EVI', 'NBR', 'NBI'];
var selectedIndex = 'NDVI';

// ---------------------------------------------------------------------------
// Band prep (mirrors gee_data_sentinel.py's Collection-2 path) + the 4 indices.
// ---------------------------------------------------------------------------

function addIndices(img) {
  var ndvi = img.normalizedDifference(['NIR', 'Red']).rename('NDVI');
  var nbr = img.normalizedDifference(['NIR', 'SWIR2']).rename('NBR');
  var nbi = img.normalizedDifference(['SWIR1', 'NIR']).rename('NBI'); // NDBI
  var evi = img.expression(
    '2.5 * ((NIR - Red) / (NIR + 6 * Red - 7.5 * Blue + 1))',
    {NIR: img.select('NIR'), Red: img.select('Red'), Blue: img.select('Blue')}
  ).rename('EVI');
  return img.addBands([ndvi, nbr, evi, nbi]);
}

function prepSentinel(img) {
  var blue = img.select('B2').rename('Blue').divide(10000);
  var green = img.select('B3').rename('Green').divide(10000);
  var red = img.select('B4').rename('Red').divide(10000);
  var nir = img.select('B8').rename('NIR').divide(10000);
  var swir1 = img.select('B11').rename('SWIR1').divide(10000);
  var swir2 = img.select('B12').rename('SWIR2').divide(10000);
  return addIndices(img.addBands([blue, green, red, nir, swir1, swir2]));
}

// Landsat 8 Collection 2 band layout (SR_B2=Blue ... SR_B5=NIR, SR_B6=SWIR1, SR_B7=SWIR2)
function prepL8(img) {
  var opt = img.select('SR_B.').multiply(0.0000275).add(-0.2);
  var blue = opt.select('SR_B2').rename('Blue');
  var green = opt.select('SR_B3').rename('Green');
  var red = opt.select('SR_B4').rename('Red');
  var nir = opt.select('SR_B5').rename('NIR');
  var swir1 = opt.select('SR_B6').rename('SWIR1');
  var swir2 = opt.select('SR_B7').rename('SWIR2');
  return addIndices(img.addBands([blue, green, red, nir, swir1, swir2]));
}

// ---------------------------------------------------------------------------
// Per-sensor collections
// ---------------------------------------------------------------------------

function sentinelCollection(startDate, endDate) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(point).filterDate(startDate, endDate)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40))
    .map(prepSentinel);
}

function landsat8Collection(startDate, endDate) {
  return ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .filterBounds(point).filterDate(startDate, endDate).map(prepL8);
}

// Full historical ranges (2015-present), for the time-series charts and the "jump to
// clicked date" lookup.
var s2Full = sentinelCollection(HISTORY_START, thisYear + 1 + '-01-01');
var l8Full = landsat8Collection(HISTORY_START, thisYear + 1 + '-01-01');

// Nearest image to a given ms-since-epoch timestamp (already normalized from whatever raw
// form the chart's onClick xValue arrived in - see parseChartClickDate below).
function findClosestImage(collection, timestampMs) {
  var target = ee.Date(timestampMs);
  return collection
    .map(function (img) { return img.set('dateDiff', ee.Number(img.date().difference(target, 'day')).abs()); })
    .sort('dateDiff')
    .first();
}

// ---------------------------------------------------------------------------
// Map panels - one per sensor, each with its own year slider + status label. The map
// always shows the *selected index*, colored (never true-color RGB) - see renderSensor().
// ---------------------------------------------------------------------------

// Index color-bar legend (standard EE Apps pattern: a synthetic left-to-right gradient
// image, visualized through the same palette/min/max as the actual layer, rendered as a
// thumbnail strip). Rebuilt (not just relabeled) whenever the selected index changes,
// since min/max/palette differ per index.
function indexLegend(indexKey) {
  var cfg = INDEX_CONFIGS[indexKey];
  var gradient = ee.Image.pixelLonLat().select('longitude');
  var thumb = ui.Thumbnail({
    image: gradient,
    params: {bbox: [0, 0, 1, 0.1], dimensions: '200x12', min: 0, max: 1, palette: cfg.palette},
    style: {stretch: 'horizontal', margin: '0'},
  });
  var labels = ui.Panel(
    [ui.Label(cfg.min, {margin: '0 0 4px 0'}),
     ui.Label(indexKey, {margin: '0 0 4px 0', stretch: 'horizontal', textAlign: 'center'}),
     ui.Label(cfg.max, {margin: '0 0 4px 0'})],
    ui.Panel.Layout.Flow('horizontal'), {stretch: 'horizontal'}
  );
  return ui.Panel([labels, thumb], ui.Panel.Layout.Flow('vertical'),
    {position: 'bottom-left', backgroundColor: 'rgba(255, 255, 255, 0.85)', padding: '6px', width: '220px'});
}

var s2Map = ui.Map();
var l8Map = ui.Map();
[s2Map, l8Map].forEach(function (m) {
  // ui.Map()'s constructor takes positional (center, zoom, gestureHandling, style)
  // args, NOT an options object like most other ui widgets - passing {style:...} to
  // the constructor is silently ignored. Style has to be set after construction.
  m.style().set('height', MAP_HEIGHT);
  m.centerObject(point, 14);
  m.setControlVisibility({layerList: false, zoomControl: true, scaleControl: true});
});
var s2LegendWidget = indexLegend(selectedIndex);
var l8LegendWidget = indexLegend(selectedIndex);
s2Map.add(s2LegendWidget);
l8Map.add(l8LegendWidget);

var s2StatusLabel = ui.Label('Sentinel-2 - loading...');
var l8StatusLabel = ui.Label('Landsat 8 - loading...');

// The point being analyzed by CCD, as a small red circle marker, plus a 50m-radius buffer
// around it - drawn as an unfilled outline (so it doesn't hide the layer underneath) and
// also used below as the region for the buffer-median time series chart. Both the marker
// and outline are re-added on top of every layer (map.layers().reset() clears them each
// time a layer changes).
var BUFFER_RADIUS_M = 50;
var bufferGeom = point.buffer(BUFFER_RADIUS_M);
var pointMarker = ee.FeatureCollection([ee.Feature(point)]).style({color: 'ff0000', pointSize: 5, pointShape: 'circle', width: 2});
var pointBuffer = ee.FeatureCollection([ee.Feature(bufferGeom)]).style({color: 'ff0000', fillColor: '00000000', width: 2});
function markPoint(map) { map.addLayer(pointBuffer, {}, 'CCD point buffer (' + BUFFER_RADIUS_M + 'm)'); map.addLayer(pointMarker, {}, 'CCD point'); }

// What each map is currently showing, independent of the selected index - lets
// onIndexChange() redraw "the same thing, new index" without duplicating the three
// display modes (year composite / recent composite / single clicked date).
var s2State = {mode: 'default'};
var l8State = {mode: 'default'};

function renderSensor(map, statusLabel, sensorLabel, collectionFn, fullCollection, state) {
  var cfg = INDEX_CONFIGS[selectedIndex];
  var visParams = {bands: [selectedIndex], min: cfg.min, max: cfg.max, palette: cfg.palette};
  map.layers().reset();

  if (state.mode === 'date') {
    var img = findClosestImage(fullCollection, state.ts);
    var dateStr = new Date(state.ts).toISOString().slice(0, 10);
    map.addLayer(img.select(selectedIndex), visParams, sensorLabel + ' ' + selectedIndex + ' ' + dateStr);
    statusLabel.setValue(sensorLabel + ' - single image ' + dateStr + ' (' + selectedIndex + ')');
  } else {
    var start, end, label;
    if (state.mode === 'year') {
      start = state.year + '-01-01';
      end = (state.year + 1) + '-01-01';
      label = String(state.year);
    } else {
      end = ee.Date(Date.now());
      start = end.advance(-365, 'day');
      label = '(recent)';
    }
    var composite = collectionFn(start, end).median();
    map.addLayer(composite.select(selectedIndex), visParams, sensorLabel + ' ' + selectedIndex + ' ' + label);
    statusLabel.setValue(sensorLabel + ' - ' + selectedIndex + ' composite ' + label);
  }
  markPoint(map);
}

function updateS2(year) { s2State = {mode: 'year', year: year}; renderSensor(s2Map, s2StatusLabel, 'Sentinel-2', sentinelCollection, s2Full, s2State); }
function updateL8(year) { l8State = {mode: 'year', year: year}; renderSensor(l8Map, l8StatusLabel, 'Landsat 8', landsat8Collection, l8Full, l8State); }

var s2Slider = ui.Slider({min: 2015, max: thisYear, value: thisYear, step: 1, style: {stretch: 'horizontal'}, onChange: updateS2});
var l8Slider = ui.Slider({min: 2015, max: thisYear, value: thisYear, step: 1, style: {stretch: 'horizontal'}, onChange: updateL8});

renderSensor(s2Map, s2StatusLabel, 'Sentinel-2', sentinelCollection, s2Full, s2State);
renderSensor(l8Map, l8StatusLabel, 'Landsat 8', landsat8Collection, l8Full, l8State);

// ---------------------------------------------------------------------------
// Time series charts, one per sensor, for the selected index. Click a point to load that
// date's image (in the selected index's colors) on the matching map above.
// ---------------------------------------------------------------------------

// No fixed vAxis viewWindow - real values at a point rarely span the full theoretical
// range, so a hardcoded range would squash the chart. explorer: native Google Charts
// option (ui.Chart passes setOptions straight through) - drag to zoom (axis: 'both'),
// right-click to reset.
var CHART_EXPLORER = {axis: 'both', keepInBounds: true, actions: ['dragToZoom', 'rightClickToReset']};

function chartOptions(sensorLabel) {
  return {title: sensorLabel + ' ' + selectedIndex + ' at point (drag to zoom, right-click to reset - click a point to load that image)',
    pointSize: 2, lineWidth: 1, explorer: CHART_EXPLORER};
}

function bufferChartOptions(sensorLabel) {
  return {title: sensorLabel + ' ' + selectedIndex + ' median in ' + BUFFER_RADIUS_M + 'm buffer (drag to zoom, right-click to reset)',
    pointSize: 2, lineWidth: 1, explorer: CHART_EXPLORER};
}

// xValue can arrive as either a raw ms-since-epoch number or a formatted date string
// (Highcharts-style, e.g. "Aug 14, 2023") depending on the chart's x-axis config -
// `new Date(xValue)` (client-side JS) parses both reliably, unlike handing the raw
// value straight to ee.Date() (server-side), which only accepts ISO/ms-numeric input.
function parseChartClickDate(xValue, statusLabel, sensorLabel) {
  var jsDate = new Date(xValue);
  var timestampMs = jsDate.getTime();
  if (isNaN(timestampMs)) {
    statusLabel.setValue(sensorLabel + ' - could not read the clicked date (' + xValue + ')');
    return null;
  }
  return timestampMs;
}

function onChartClick(map, statusLabel, sensorLabel, state, xValue) {
  var timestampMs = parseChartClickDate(xValue, statusLabel, sensorLabel);
  if (timestampMs === null) return;
  state.mode = 'date';
  state.ts = timestampMs;
  statusLabel.setValue(sensorLabel + ' - loading clicked date...');
  renderSensor(map, statusLabel, sensorLabel, null, map === s2Map ? s2Full : l8Full, state);
}

// s2State/l8State + their chart/reset-button/onClick wiring are rebuilt as a unit whenever
// the selected index changes (see onIndexChange) - kept as plain vars (not returned from a
// factory) since there's only ever exactly one chart pair per sensor, no need for more
// structure. "Buffer" variants are the same series but reduced (median) over bufferGeom
// instead of sampled at the point.
var s2Chart, l8Chart, s2ResetZoomBtn, l8ResetZoomBtn;
var s2BufferChart, l8BufferChart, s2BufferResetZoomBtn, l8BufferResetZoomBtn;

function buildChart(fullCollection, sensorLabel) {
  return ui.Chart.image.series(fullCollection.select(selectedIndex), point, ee.Reducer.mean(), 10).setOptions(chartOptions(sensorLabel));
}

function buildBufferChart(fullCollection, sensorLabel) {
  return ui.Chart.image.series(fullCollection.select(selectedIndex), bufferGeom, ee.Reducer.median(), 10).setOptions(bufferChartOptions(sensorLabel));
}

function initChart(sensorKey) {
  if (sensorKey === 's2') {
    s2Chart = buildChart(s2Full, 'Sentinel-2');
    s2Chart.onClick(function (xValue) { onChartClick(s2Map, s2StatusLabel, 'Sentinel-2', s2State, xValue); });
    s2ResetZoomBtn = ui.Button({label: 'Reset zoom', onClick: function () { s2Chart.setOptions(chartOptions('Sentinel-2')); }});

    s2BufferChart = buildBufferChart(s2Full, 'Sentinel-2');
    s2BufferChart.onClick(function (xValue) { onChartClick(s2Map, s2StatusLabel, 'Sentinel-2', s2State, xValue); });
    s2BufferResetZoomBtn = ui.Button({label: 'Reset zoom', onClick: function () { s2BufferChart.setOptions(bufferChartOptions('Sentinel-2')); }});
  } else {
    l8Chart = buildChart(l8Full, 'Landsat 8');
    l8Chart.onClick(function (xValue) { onChartClick(l8Map, l8StatusLabel, 'Landsat 8', l8State, xValue); });
    l8ResetZoomBtn = ui.Button({label: 'Reset zoom', onClick: function () { l8Chart.setOptions(chartOptions('Landsat 8')); }});

    l8BufferChart = buildBufferChart(l8Full, 'Landsat 8');
    l8BufferChart.onClick(function (xValue) { onChartClick(l8Map, l8StatusLabel, 'Landsat 8', l8State, xValue); });
    l8BufferResetZoomBtn = ui.Button({label: 'Reset zoom', onClick: function () { l8BufferChart.setOptions(bufferChartOptions('Landsat 8')); }});
  }
}
initChart('s2');
initChart('l8');

// ---------------------------------------------------------------------------
// Layout: one row per sensor (its map on the left, its own chart right next to it,
// aligned) - plain Panels throughout, not ui.SplitPanel (that kept collapsing its
// firstPanel to zero width).
// ---------------------------------------------------------------------------

var indexSelect = ui.Select({
  items: INDEX_NAMES, value: selectedIndex, onChange: onIndexChange,
  style: {stretch: 'horizontal'},
});
var indexSelectRow = ui.Panel(
  [ui.Label('Index:', {margin: '8px 6px 8px 8px'}), indexSelect],
  ui.Panel.Layout.Flow('horizontal'), {stretch: 'horizontal', width: '220px'}
);

var title = ui.Label({
  value: 'CCD 2.0 Dashboard (multi-index) — Lat ' + lat.toFixed(5) + ', Lon ' + lon.toFixed(5),
  style: {fontWeight: 'bold', fontSize: '16px', textAlign: 'center', stretch: 'horizontal', margin: '8px'},
});

// width: '50%' on both the map side and the chart side - otherwise the map's own
// content width dominates the row and squeezes the chart into a narrow strip.
function sensorPanel(statusLabel, slider, map) {
  return ui.Panel([statusLabel, slider, map], ui.Panel.Layout.Flow('vertical'), {stretch: 'both', width: '50%'});
}
// Point chart + its reset-zoom button, then the buffer-median chart + its own reset-zoom
// button, stacked - the width: '50%' moves to this wrapping panel (each chart itself just
// stretches to fill it) so the buttons line up above their chart. Kept as module-level vars
// (not returned) so onIndexChange() can swap widget indices 1 and 3 in-place when the charts
// are rebuilt for a new index.
function chartPanel(resetBtn, chart, bufferResetBtn, bufferChart) {
  chart.style().set('stretch', 'horizontal');
  bufferChart.style().set('stretch', 'horizontal');
  return ui.Panel([resetBtn, chart, bufferResetBtn, bufferChart], ui.Panel.Layout.Flow('vertical'), {stretch: 'both', width: '50%'});
}

var s2ChartPanel = chartPanel(s2ResetZoomBtn, s2Chart, s2BufferResetZoomBtn, s2BufferChart);
var l8ChartPanel = chartPanel(l8ResetZoomBtn, l8Chart, l8BufferResetZoomBtn, l8BufferChart);

var s2Row = ui.Panel([sensorPanel(s2StatusLabel, s2Slider, s2Map), s2ChartPanel],
  ui.Panel.Layout.Flow('horizontal'), {stretch: 'both'});
var l8Row = ui.Panel([sensorPanel(l8StatusLabel, l8Slider, l8Map), l8ChartPanel],
  ui.Panel.Layout.Flow('horizontal'), {stretch: 'both'});

var body = ui.Panel([s2Row, l8Row], ui.Panel.Layout.Flow('vertical'), {stretch: 'both'});

// Declared after s2/l8 Row (ui.Select's onChange fires only on user interaction, not on
// construction, so it's safe to wire before the panels it touches exist - but defining it
// here, after everything it references, keeps the read order top-to-bottom sane).
function onIndexChange(newIndex) {
  selectedIndex = newIndex;

  s2Map.remove(s2LegendWidget); s2LegendWidget = indexLegend(selectedIndex); s2Map.add(s2LegendWidget);
  l8Map.remove(l8LegendWidget); l8LegendWidget = indexLegend(selectedIndex); l8Map.add(l8LegendWidget);

  initChart('s2'); initChart('l8');
  s2ChartPanel.widgets().set(0, s2ResetZoomBtn); s2ChartPanel.widgets().set(1, s2Chart);
  s2ChartPanel.widgets().set(2, s2BufferResetZoomBtn); s2ChartPanel.widgets().set(3, s2BufferChart);
  l8ChartPanel.widgets().set(0, l8ResetZoomBtn); l8ChartPanel.widgets().set(1, l8Chart);
  l8ChartPanel.widgets().set(2, l8BufferResetZoomBtn); l8ChartPanel.widgets().set(3, l8BufferChart);

  renderSensor(s2Map, s2StatusLabel, 'Sentinel-2', sentinelCollection, s2Full, s2State);
  renderSensor(l8Map, l8StatusLabel, 'Landsat 8', landsat8Collection, l8Full, l8State);
}

ui.root.clear();
ui.root.add(ui.Panel([title, indexSelectRow, body], ui.Panel.Layout.Flow('vertical'), {stretch: 'both'}));
