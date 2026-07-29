# "Dashboard" button: composite as a real pan/zoom Leaflet map (live GEE XYZ tiles) + the
# already-generated CCDC chart, combined into one HTML file opened in the system browser.
# See gui/CCD_Plugin_dockwidget.py:open_dashboard/compute_dashboard/dashboard_completed.
import os
import tempfile

from qgis.PyQt.QtCore import QUrl

# ponytail: fixed buffer instead of a new Advanced Settings field - a reasonable default
# for "some area around the point", not worth a new UI control yet.
DASHBOARD_BUFFER_METERS = 1000
COMPOSITE_VIS_PARAMS = {"bands": ["Red", "Green", "Blue"], "min": 0.0, "max": 0.3}
DASHBOARD_ZOOM = 14

LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"


def get_composite_tile_url(coords, date_range, doy_range, dataset):
    """Median composite over a buffer around the point, using the same filtered/harmonized
    collections compute_ccd already relies on (no new band-prep code). Returns a live GEE
    XYZ tile URL template (ee.Image.getMapId) for a pan/zoom Leaflet layer - no local file,
    no static thumbnail. ee.Initialize() must already have been called by the caller."""
    import ee

    from CCD_Plugin.core.gee_data_landsat import get_gee_data_landsat
    from CCD_Plugin.core.gee_data_sentinel import get_gee_data_sentinel

    point = ee.Geometry.Point(coords)
    region = point.buffer(DASHBOARD_BUFFER_METERS).bounds()

    if dataset == "Sentinel-2":
        collection = get_gee_data_sentinel(coords, date_range, doy_range, dataset)
    elif dataset == "Landsat C1":
        collection = get_gee_data_landsat(coords, date_range, doy_range, 1)
    elif dataset == "Landsat C2":
        collection = get_gee_data_landsat(coords, date_range, doy_range, 2)
    else:
        raise Exception(f"Unknown dataset|Unsupported dataset for dashboard: {dataset}")

    if collection.size().getInfo() == 0:
        raise Exception(
            "No imagery for composite|No cloud-free scenes were found for this point, date range "
            "and dataset. Try widening the date range or day-of-year filter."
        )

    composite = collection.median().clip(region)
    map_id = composite.getMapId(COMPOSITE_VIS_PARAMS)
    return map_id["tile_fetcher"].url_format


def build_dashboard_html(tmp_dir, tile_url, ccdc_html_file, config):
    """Combine a pan/zoom Leaflet map (live GEE tiles) with the existing CCDC Plotly chart
    (embedded via <iframe>, so generate_plot()'s standalone-HTML-file contract never has to
    change) into one HTML file, written into the same per-session tmp_dir as the chart
    (cleaned up together). Leaflet itself is pulled from its CDN - the page already needs
    internet access for the GEE tiles, so no reason to vendor Leaflet into the plugin."""
    fd, dashboard_file = tempfile.mkstemp(suffix=".html", dir=tmp_dir)
    os.close(fd)

    ccdc_file_url = QUrl.fromLocalFile(ccdc_html_file).toString()

    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>CCD-Plugin Dashboard - {config['lat']}, {config['lon']}</title>
<link rel="stylesheet" href="{LEAFLET_CSS}" />
<script src="{LEAFLET_JS}"></script>
<style>
  body {{ margin:0; font-family:sans-serif; }}
  h3 {{ text-align:center; margin:8px 0; }}
  #map {{ height:500px; width:100%; }}
  iframe {{ width:100%; height:650px; border:none; display:block; }}
</style></head>
<body>
  <h3>{config['dataset']} composite &amp; CCDC time series &mdash;
      Lat {config['lat']}, Lon {config['lon']} ({config['start_date']} to {config['end_date']})</h3>
  <div id="map"></div>
  <iframe src="{ccdc_file_url}"></iframe>
  <script>
    var map = L.map('map').setView([{config['lat']}, {config['lon']}], {DASHBOARD_ZOOM});
    L.tileLayer('{tile_url}', {{attribution: 'Google Earth Engine', maxZoom: 20}}).addTo(map);
    L.marker([{config['lat']}, {config['lon']}]).addTo(map);
  </script>
</body></html>
"""
    with open(dashboard_file, "w", encoding="utf-8") as f:
        f.write(html)
    return dashboard_file
