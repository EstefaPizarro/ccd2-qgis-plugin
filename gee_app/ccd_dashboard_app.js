// CCD 2.0 - Point Dashboard (Google Earth Engine App)
//
// Not run from Python - paste this into code.earthengine.google.com, run it once to
// preview, then Apps > Publish new App. The published app's URL is what the "GEE App"
// button in the CCD 2.0 QGIS plugin opens (with the current point appended as
// #geoJson=... - see CCD_Plugin/gui/CCD_Plugin_dockwidget.py:open_gee_app).
//
// Band-prep/NDVI formulas below intentionally mirror CCD_Plugin/core/gee_data_sentinel.py
// and gee_data_landsat.py (same scale factors, same band names) so the NDVI shown here
// matches what the plugin computes - a GEE App can't import that Python, so if those
// files ever change their scaling/band choices, update this script by hand to match.
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
var rgbVisParams = {bands: ['Red', 'Green', 'Blue'], min: 0, max: 0.3};
var ndviVisParams = {bands: ['NDVI'], min: -1, max: 1, palette: ['a50026', 'f46d43', 'ffffbf', '66bd63', '1a9850']};
var MAP_HEIGHT = '350px'; // ui.Map() has no default height - without this it renders invisible

// ---------------------------------------------------------------------------
// Band prep (mirrors gee_data_sentinel.py / gee_data_landsat.py's Collection-2 path)
// ---------------------------------------------------------------------------

function prepSentinel(img) {
  var blue = img.select('B2').rename('Blue').divide(10000);
  var green = img.select('B3').rename('Green').divide(10000);
  var red = img.select('B4').rename('Red').divide(10000);
  var nir = img.select('B8').rename('NIR').divide(10000);
  var ndvi = nir.subtract(red).divide(nir.add(red)).rename('NDVI');
  return img.addBands([blue, green, red, nir, ndvi]);
}

// Landsat 8 Collection 2 band layout (SR_B2=Blue ... SR_B5=NIR)
function prepL8(img) {
  var opt = img.select('SR_B.').multiply(0.0000275).add(-0.2);
  var blue = opt.select('SR_B2').rename('Blue');
  var green = opt.select('SR_B3').rename('Green');
  var red = opt.select('SR_B4').rename('Red');
  var nir = opt.select('SR_B5').rename('NIR');
  var ndvi = nir.subtract(red).divide(nir.add(red)).rename('NDVI');
  return img.addBands([blue, green, red, nir, ndvi]);
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
// Map panels - one per sensor, each with its own year slider + status label.
// ---------------------------------------------------------------------------

// NDVI color-bar legend (standard EE Apps pattern: a synthetic left-to-right gradient
// image, visualized through the same palette/min/max as the actual NDVI layers, rendered
// as a thumbnail strip) - overlaid on each map so the palette is always visible.
function ndviLegend() {
  var gradient = ee.Image.pixelLonLat().select('longitude');
  var thumb = ui.Thumbnail({
    image: gradient,
    params: {bbox: [0, 0, 1, 0.1], dimensions: '200x12', min: 0, max: 1, palette: ndviVisParams.palette},
    style: {stretch: 'horizontal', margin: '0'},
  });
  var labels = ui.Panel(
    [ui.Label(ndviVisParams.min, {margin: '0 0 4px 0'}),
     ui.Label('NDVI', {margin: '0 0 4px 0', stretch: 'horizontal', textAlign: 'center'}),
     ui.Label(ndviVisParams.max, {margin: '0 0 4px 0'})],
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
  m.add(ndviLegend()); // each map needs its own widget instance, can't share one
});

var s2StatusLabel = ui.Label('Sentinel-2 - loading...');
var l8StatusLabel = ui.Label('Landsat 8 - loading...');

// The point being analyzed by CCD, as a small red diamond marker - re-added on top of every
// composite/single-image layer below (map.layers().reset() clears it each time a layer changes).
var pointMarker = ee.FeatureCollection([ee.Feature(point)]).style({color: 'ff0000', pointSize: 8, pointShape: 'diamond', width: 2});
function markPoint(map) { map.addLayer(pointMarker, {}, 'CCD point'); }

// Generic: build+show a calendar-year composite for one sensor/map/slider.
function updateSensorYear(map, statusLabel, sensorLabel, collectionFn, year) {
  var composite = collectionFn(year + '-01-01', (year + 1) + '-01-01').median();
  map.layers().reset();
  map.addLayer(composite, rgbVisParams, sensorLabel + ' ' + year);
  markPoint(map);
  statusLabel.setValue(sensorLabel + ' - composite ' + year);
}

// Generic: rolling window ending today - guarantees something renders by default even
// if the current calendar year has no imagery yet (fixed Jan-1..Dec-31 windows can be
// empty for months into a new year).
function updateSensorDefault(map, statusLabel, sensorLabel, collectionFn, days) {
  var end = ee.Date(Date.now());
  var start = end.advance(-days, 'day');
  var composite = collectionFn(start, end).median();
  map.layers().reset();
  map.addLayer(composite, rgbVisParams, sensorLabel + ' (recent)');
  markPoint(map);
  statusLabel.setValue(sensorLabel + ' - composite (last ' + days + ' days)');
}

function updateS2(year) { updateSensorYear(s2Map, s2StatusLabel, 'Sentinel-2', sentinelCollection, year); }
function updateL8(year) { updateSensorYear(l8Map, l8StatusLabel, 'Landsat 8', landsat8Collection, year); }

var s2Slider = ui.Slider({min: 2015, max: thisYear, value: thisYear, step: 1, style: {stretch: 'horizontal'}, onChange: updateS2});
var l8Slider = ui.Slider({min: 2015, max: thisYear, value: thisYear, step: 1, style: {stretch: 'horizontal'}, onChange: updateL8});

updateSensorDefault(s2Map, s2StatusLabel, 'Sentinel-2', sentinelCollection, 365);
updateSensorDefault(l8Map, l8StatusLabel, 'Landsat 8', landsat8Collection, 365);

// ---------------------------------------------------------------------------
// NDVI time series charts. Click a point to load that date's image as NDVI on the
// matching map above.
// ---------------------------------------------------------------------------

// No fixed vAxis viewWindow - a hardcoded -1..1 range squashed the actual NDVI values into a
// thin band since real NDVI at a point rarely spans the full theoretical range. Leaving
// viewWindow unset lets Google Charts auto-scale to the plotted data for each sensor.
//
// explorer: native Google Charts option (ui.Chart passes setOptions straight through to it,
// no custom code needed) - drag on the chart to zoom into a date range AND a value range
// (axis: 'both' - not just horizontal), right-click to reset. Shared by both charts, so the
// vAxis is freely draggable/zoomable for Landsat too, not just auto-ranged at load.
var CHART_EXPLORER = {axis: 'both', keepInBounds: true, actions: ['dragToZoom', 'rightClickToReset']};

// Kept as named objects (not inlined into .setOptions) so the "Reset zoom" buttons below can
// re-apply the exact original options - that's how you undo an explorer zoom/pan
// programmatically, there's no separate "reset" call on the chart itself.
var s2ChartOptions = {title: 'Sentinel-2 NDVI (drag to zoom, right-click to reset - click a point to load that image)',
  pointSize: 2, lineWidth: 1, explorer: CHART_EXPLORER};
var l8ChartOptions = {title: 'Landsat 8 NDVI (drag to zoom, right-click to reset - click a point to load that image)',
  pointSize: 2, lineWidth: 1, explorer: CHART_EXPLORER};

var s2Chart = ui.Chart.image.series(s2Full.select('NDVI'), point, ee.Reducer.mean(), 10).setOptions(s2ChartOptions);
var l8Chart = ui.Chart.image.series(l8Full.select('NDVI'), point, ee.Reducer.mean(), 30).setOptions(l8ChartOptions);

var s2ResetZoomBtn = ui.Button({label: 'Reset zoom', onClick: function () { s2Chart.setOptions(s2ChartOptions); }});
var l8ResetZoomBtn = ui.Button({label: 'Reset zoom', onClick: function () { l8Chart.setOptions(l8ChartOptions); }});

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
  return {jsDate: jsDate, timestampMs: timestampMs};
}

function showSingleImage(map, statusLabel, sensorLabel, collection, xValue) {
  statusLabel.setValue(sensorLabel + ' - loading clicked date...');
  var parsedDate = parseChartClickDate(xValue, statusLabel, sensorLabel);
  if (!parsedDate) return;
  var img = findClosestImage(collection, parsedDate.timestampMs);
  var dateStr = parsedDate.jsDate.toISOString().slice(0, 10);
  map.layers().reset();
  map.addLayer(img.select('NDVI'), ndviVisParams, sensorLabel + ' NDVI ' + dateStr);
  markPoint(map);
  statusLabel.setValue(sensorLabel + ' - single image ' + dateStr + ' (NDVI)');
}

s2Chart.onClick(function (xValue) { showSingleImage(s2Map, s2StatusLabel, 'Sentinel-2', s2Full, xValue); });
l8Chart.onClick(function (xValue) { showSingleImage(l8Map, l8StatusLabel, 'Landsat 8', l8Full, xValue); });

// ---------------------------------------------------------------------------
// Layout: one row per sensor (its map on the left, its own chart right next to it,
// aligned) - plain Panels throughout, not ui.SplitPanel (that kept collapsing its
// firstPanel to zero width).
// ---------------------------------------------------------------------------

var title = ui.Label({
  value: 'CCD 2.0 Dashboard — Lat ' + lat.toFixed(5) + ', Lon ' + lon.toFixed(5),
  style: {fontWeight: 'bold', fontSize: '16px', textAlign: 'center', stretch: 'horizontal', margin: '8px'},
});

// width: '50%' on both the map side and the chart side - otherwise the map's own
// content width dominates the row and squeezes the chart into a narrow strip.
function sensorPanel(statusLabel, slider, map) {
  return ui.Panel([statusLabel, slider, map], ui.Panel.Layout.Flow('vertical'), {stretch: 'both', width: '50%'});
}
// Chart + its reset-zoom button, stacked - the width: '50%' moves to this wrapping panel
// (the chart itself just stretches to fill it) so the button lines up above the chart.
function chartPanel(resetBtn, chart) {
  chart.style().set('stretch', 'horizontal');
  return ui.Panel([resetBtn, chart], ui.Panel.Layout.Flow('vertical'), {stretch: 'both', width: '50%'});
}

var s2Row = ui.Panel([sensorPanel(s2StatusLabel, s2Slider, s2Map), chartPanel(s2ResetZoomBtn, s2Chart)],
  ui.Panel.Layout.Flow('horizontal'), {stretch: 'both'});
var l8Row = ui.Panel([sensorPanel(l8StatusLabel, l8Slider, l8Map), chartPanel(l8ResetZoomBtn, l8Chart)],
  ui.Panel.Layout.Flow('horizontal'), {stretch: 'both'});

var body = ui.Panel([s2Row, l8Row], ui.Panel.Layout.Flow('vertical'), {stretch: 'both'});

ui.root.clear();
ui.root.add(ui.Panel([title, body], ui.Panel.Layout.Flow('vertical'), {stretch: 'both'}));
