# CCD 2.0

QGIS plugin: pick a point on the canvas, run Continuous Change Detection (CCDC) on it via
Google Earth Engine, and plot the fitted harmonic curve - plus a button to open a full
interactive GEE dashboard (composites + time-series charts) for that same point.

## Credits & license

`CCD_Plugin/` in this repo is an unmodified copy of
[CCD-Plugin](https://github.com/SMByC/CCD-Plugin) by Xavier Corredor Llano
(SMByC - Sistema de Monitoreo de Bosques y Carbono, IDEAM), except for the fixes and the one
added button listed below. Original and this project are both licensed under the
[GNU GPLv3](LICENSE).

## What's new vs. the original

- **"GEE App" button** - opens an interactive Earth Engine App dashboard for the current point
  (composites + time-series charts, computed entirely in the browser). Works out of the box
  against the maintainer's own published app; right-click to point it at a different one
  instead. See Usage below.
- **`gee_app/*.js`** - the two standalone Earth Engine scripts behind that dashboard, in case
  you want to publish your own (e.g. if the shared one gets slow under load - see "Publish
  your own Earth Engine App" below).
- Everything else (CEO composites/dashboard/field-validation fusion) was reset; ask for those
  as separate improvements when wanted.

## Fixes applied on top of the original

- **Harmonic reconstruction bug** (`CCD_Plugin/core/plot.py`): coefs[3]/[5]/[7] (the sin terms)
  were using `cos()` instead of `sin()`.
- **`dates_obs` dtype** (`CCD_Plugin/core/plot.py`): `getRegion()` mixes a string `id` column with
  the numeric ones, so numpy stores the whole table as strings - cast to `int64` before using it
  as a timestamp (`values_obs` already did this, `dates_obs` didn't).
- **`zip(..., strict=True)`**: Python 3.10+ only: removed (QGIS 3.32 ships Python 3.9).
- **Qt6-style scoped enums in `.ui` files** (`A::B::C`, e.g. `Qt::Orientation::Horizontal`):
  PyQt5's `uic` compiler can't parse those - collapsed to the classic `A::C` form.
- **`ee.Initialize()`**: current earthengine-api requires a Cloud project on every call. The
  first time "Generate" runs, a dialog asks for the Earth Engine Cloud project ID and
  remembers it via `QgsSettings` (per QGIS profile - works for any user, no env var needed).
  `EE_PROJECT` env var still overrides if set.

## Install from GitHub

1. On this repo's GitHub page, **Code → Download ZIP** (or `git clone` it).
2. QGIS → *Plugins → Manage and Install Plugins → Install from ZIP* → pick the ZIP you just
   downloaded (if you cloned instead, zip the repo folder first).
3. Enable the plugin. The first time it loads, it installs its required Python packages
   automatically (a small progress dialog appears for ~10-30s, no console needed). If that
   ever fails (e.g. no internet), run `pip install -r requirements.txt` into your QGIS Python
   environment by hand.
4. Run `earthengine authenticate` once (or set `EE_PRIVATE_KEY_JSON`/service-account
   credentials - see CCD_Plugin's own docs). The Earth Engine Cloud project ID itself is
   asked for in-app, the first time you click "Generate".

## Usage

Matches the original CCD-Plugin exactly: toolbar/menu icon opens the dock (not auto-shown),
"Pick on Map" then click the canvas, "Generate" runs CCDC and plots the fitted curve embedded
in the dock panel, "Open in browser" opens the same plot externally.

One extra button, which opens in your system browser (the embedded `QWebEngineView` panel is
known-broken on some Windows/Chromium setups - unrelated to this plugin's code):

- **GEE App**: opens a published Earth Engine App with the current point, for a fully
  interactive dashboard - composites on the left (Sentinel-2 and Landsat 8, both
  2015-present, each with its own year slider), NDVI time-series charts on the right -
  click a point on a chart to load that exact date's image (as NDVI) on the matching
  panel. Earth Engine computes everything itself in the browser, under the app publisher's
  quota - no setup needed, it just works. Right-click the button to switch to a different
  published app (yours or anyone else's) - saved via `QgsSettings`, per QGIS profile.

### Publish your own Earth Engine App (optional)

Only needed if you want your own copy - e.g. the shared default app gets slow if a lot of
people are using it at once, since everyone's browser hits the same publisher quota.
`gee_app/ccd_dashboard_app.js` is a standalone script (not run by Python/QGIS) that becomes
your own permanent, shareable dashboard link:

1. Go to https://code.earthengine.google.com/, paste in the contents of `gee_app/ccd_dashboard_app.js`.
2. Click **Run** to preview it.
3. **Apps → Publish new App**, pick a Cloud project and app name, publish.
4. Copy the resulting URL (looks like `https://<project>.projects.earthengine.app/view/<app-name>`).
5. In QGIS, click **"GEE App"** - paste that URL when asked. It opens with the current point
   loaded from then on.
