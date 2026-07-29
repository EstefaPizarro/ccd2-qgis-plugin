# CCD_Plugin/ below is an unmodified copy of CCD-Plugin-master (github.com/SMByC/CCD-Plugin),
# whose own imports are absolute (`from CCD_Plugin.x import y`), assuming it's installed as
# the top-level "plugins/CCD_Plugin" folder. Since we keep this outer folder's own name for
# the QGIS plugin identity, add our own dir to sys.path so those imports resolve unchanged.
import os
import sys

_plugin_dir = os.path.dirname(__file__)
if _plugin_dir not in sys.path:
    sys.path.insert(0, _plugin_dir)


def classFactory(iface):
    from CCD_Plugin import classFactory as _classFactory

    return _classFactory(iface)
