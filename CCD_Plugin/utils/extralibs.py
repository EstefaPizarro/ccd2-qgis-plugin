"""
/***************************************************************************
 CCD Plugin
                                A QGIS plugin
 Continuous Change Detection Plugin
                              -------------------
        copyright            : (C) 2019-2026 by Xavier Corredor Llano, SMByC
        email                : xavier.corredor.llano@gmail.com
 ***************************************************************************/

/***************************************************************************
 *                                                                         *
 *   This program is free software; you can redistribute it and/or modify  *
 *   it under the terms of the GNU General Public License as published by  *
 *   the Free Software Foundation; either version 2 of the License, or     *
 *   (at your option) any later version.                                   *
 *                                                                         *
 ***************************************************************************/
"""

import os
import shutil
import subprocess
import sys

try:
    from qgis.core import Qgis, QgsMessageLog
    from qgis.PyQt.QtCore import Qt
    from qgis.PyQt.QtWidgets import (
        QApplication,
        QDialog,
        QHBoxLayout,
        QLabel,
        QMessageBox,
        QProgressBar,
        QPushButton,
        QVBoxLayout,
    )
except ImportError:
    # Only hit outside a running QGIS, to run this file's self-check (see __main__ below).
    QDialog = object


def _plugin_root() -> str:
    """Root folder of the plugin (three levels up: utils/ -> CCD_Plugin/ -> root)."""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _find_python_exe() -> str:
    """Locate the actual Python interpreter behind the running QGIS process.

    ``sys.executable`` is unreliable here: on Windows it resolves to the QGIS host
    binary (``qgis-bin.exe``), not a real Python interpreter, so `sys.executable -m
    pip` fails with FileNotFoundError (https://github.com/qgis/QGIS/issues/45646).
    ``sys.exec_prefix`` still points at the actual Python install dir regardless of
    which executable launched the interpreter, so look for python(.exe) there first.
    """
    candidates = [
        os.path.join(sys.exec_prefix, "python.exe"),  # Windows
        os.path.join(sys.exec_prefix, "bin", "python3"),  # Linux/Mac bundled
        sys.executable,  # fallback: correct on Linux/Mac, and better than nothing
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return sys.executable


def _build_pip_command(python_exe: str, extlibs_dir: str, requirements_path: str) -> list[str]:
    """Build the `pip install` argv that installs requirements_path's packages into extlibs_dir."""
    return [
        python_exe, "-m", "pip", "install", "--upgrade",
        "--target", extlibs_dir, "-r", requirements_path,
    ]


def _log(msg: str, level: str = "Info") -> None:
    """Write *msg* to the QGIS message log (and stdout as fallback)"""
    try:
        qgis_level = getattr(getattr(Qgis, "MessageLevel", Qgis), level)
        QgsMessageLog.logMessage(msg, tag="CCD-Plugin", level=qgis_level)
    except Exception:
        print(f"[CCD-Plugin] {msg}")


class PipInstall(QDialog):
    """Modal dialog that runs `pip install` and streams its output live."""

    def __init__(self, cmd: list[str], parent=None):
        super().__init__(parent)
        self.setWindowTitle("CCD-Plugin Installation")
        self.setModal(True)
        self.setMinimumWidth(420)
        # Keep dialog on top of the QGIS main window
        self.setWindowFlags(self.windowFlags() | Qt.WindowType.WindowStaysOnTopHint)

        self.cmd = cmd
        self._cancelled = False
        self._proc: subprocess.Popen | None = None
        self.returncode: int | None = None

        self.progress_label = QLabel("Installing required Python packages...", self)
        self.progress_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.progress_bar = QProgressBar(self)
        self.progress_bar.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.progress_bar.setRange(0, 0)  # indeterminate - pip doesn't report overall progress

        progress_layout = QVBoxLayout()
        progress_layout.addWidget(self.progress_label)
        progress_layout.addWidget(self.progress_bar)

        cancel_button = QPushButton("Cancel", self)
        cancel_button.clicked.connect(self._on_cancel)

        button_layout = QHBoxLayout()
        button_layout.addStretch()
        button_layout.addWidget(cancel_button)

        main_layout = QVBoxLayout(self)
        main_layout.addLayout(progress_layout)
        main_layout.addLayout(button_layout)
        self.adjustSize()

        self.show()
        QApplication.processEvents()

        self.returncode = self._run()

        if self.returncode == 0:
            self.progress_label.setText("Done!")
            self.progress_bar.setRange(0, 100)
            self.progress_bar.setValue(100)
        elif not self._cancelled:
            _log("pip install failed, see log above.", level="Critical")

        self.deleteLater()
        self.accept()

    def _on_cancel(self) -> None:
        self._cancelled = True
        if self._proc is not None:
            self._proc.terminate()

    def _run(self) -> int:
        """Run self.cmd, pumping its output into the QGIS log and the Qt event loop
        so the dialog stays responsive. Returns the process return code (-1 if cancelled)."""
        try:
            self._proc = subprocess.Popen(  # nosec B603
                self.cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
            )
        except Exception as exc:
            _log(f"Failed to start pip: {exc}", level="Critical")
            return -1

        for line in self._proc.stdout:  # type: ignore[union-attr]
            _log(line.rstrip())
            QApplication.processEvents()
            if self._cancelled:
                break

        self._proc.wait()
        return -1 if self._cancelled else self._proc.returncode


def get_extlibs_install_path() -> str:
    """Return the ``extlibs`` directory inside this plugin.

    Derived from this file's own location (not the QGIS profile dir + a hardcoded
    "CCD_Plugin" folder name) so it matches wherever the plugin actually got
    installed: "Install from ZIP" from a GitHub download names the top-level
    folder after the repo/branch (e.g. "ccd2-qgis-plugin-main"), not "CCD_Plugin" -
    that's only the name of the subfolder this file lives in, which is what
    pre_init_plugin() (__init__.py) also searches relative to itself.
    """
    ccd_plugin_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(ccd_plugin_dir, "extlibs")


def install() -> None:
    """Install the extra Python libraries required by CCD-Plugin via pip, into a
    plugin-local extlibs/ folder (no admin rights needed, doesn't touch QGIS's own env)."""
    extlibs_dir = get_extlibs_install_path()
    os.makedirs(extlibs_dir, exist_ok=True)
    requirements_path = os.path.join(_plugin_root(), "requirements.txt")

    cmd = _build_pip_command(_find_python_exe(), extlibs_dir, requirements_path)
    _log(f"Installing extra libs to: {extlibs_dir}")
    dialog = PipInstall(cmd)

    if dialog.returncode != 0:
        shutil.rmtree(extlibs_dir, ignore_errors=True)
        QMessageBox.critical(
            None,
            "CCD-Plugin: Error installing libs",
            (
                "Error installing the additional Python packages required for CCD-Plugin.\n\n"
                "Read the install instructions here:\n"
                "https://github.com/SMByC/CCD-Plugin#installation"
            ),
            QMessageBox.StandardButton.Ok,
        )


def _self_check() -> None:
    cmd = _build_pip_command("PY", "EXTLIBS_DIR", "REQS.txt")
    assert cmd[0] == "PY"
    assert cmd[cmd.index("--target") + 1] == "EXTLIBS_DIR"
    assert cmd[cmd.index("-r") + 1] == "REQS.txt"
    assert cmd[-2:] == ["-r", "REQS.txt"]

    # extlibs dir must live inside the CCD_Plugin/ folder this file is under, matching
    # where __init__.py's pre_init_plugin() looks - not some hardcoded/absolute guess.
    extlibs_dir = get_extlibs_install_path()
    assert os.path.basename(extlibs_dir) == "extlibs"
    assert os.path.dirname(extlibs_dir) == os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # must resolve to a real file, never the bare "python" name pip could silently fail on
    python_exe = _find_python_exe()
    assert os.path.isfile(python_exe), f"resolved python_exe does not exist: {python_exe}"

    print("extralibs self-check: ok")


if __name__ == "__main__":
    _self_check()
