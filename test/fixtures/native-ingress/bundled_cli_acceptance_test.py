"""The artifacts-manifest selection contract of `bundled_cli_acceptance.py`.

`PI_NATIVE_ARTIFACTS_MANIFEST` is the only way to name the built cohort this driver drives, and there is no
path it guesses. Nothing here submits a SLURM job: the driver is required to refuse before submission, which
is what the subprocess case observes, and the remaining cases call the selection helpers directly.

Stdlib `unittest`, like `test/slurm/submit_cases_test.py`; no Vitest config collects it.

    srun -c 4 -N 1 -p l40-reserved --qos=dev -J manifest-selection \
        env -u PIXI_PROJECT_MANIFEST pixi run --manifest-path <repo>/pixi.toml --frozen -- \
        python -m unittest discover -s <repo>/test/fixtures/native-ingress -p '*_test.py' -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[2]
DRIVER = HERE / "bundled_cli_acceptance.py"
LEGACY_NAME = "artifacts-manifest.json"
VALID_MANIFEST = {"mode": "patched", "tuiPackageRoot": "/nonexistent/cohort/pi-tui", "tuiVersion": "0.84.3"}

sys.path.insert(0, str(HERE))
import bundled_cli_acceptance  # noqa: E402  the driver under test, imported from its own directory


class ManifestSelectionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="bundled-cli-selection-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.prior = os.environ.get("PI_NATIVE_ARTIFACTS_MANIFEST")
        self.addCleanup(self.restore_selection)

    def restore_selection(self) -> None:
        if self.prior is None:
            os.environ.pop("PI_NATIVE_ARTIFACTS_MANIFEST", None)
        else:
            os.environ["PI_NATIVE_ARTIFACTS_MANIFEST"] = self.prior

    def select(self, value: str | None) -> None:
        if value is None:
            os.environ.pop("PI_NATIVE_ARTIFACTS_MANIFEST", None)
        else:
            os.environ["PI_NATIVE_ARTIFACTS_MANIFEST"] = value

    def disposable_driver(self) -> Path:
        """A copy of the driver in a throwaway repository layout, so a planted manifest cannot be the real one.

        The layout deliberately holds only what the driver needs to import: no `bundled-cli-host-preload.mjs`,
        which the driver copies before it submits, so a regression cannot reach the scheduler from here.
        """
        fixtures = self.root / "test/fixtures/native-ingress"
        fixtures.mkdir(parents=True)
        (self.root / "test/slurm").mkdir(parents=True)
        shutil.copy2(REPOSITORY / "test/slurm/submit_cases.py", self.root / "test/slurm/submit_cases.py")
        copy = fixtures / DRIVER.name
        shutil.copy2(DRIVER, copy)
        return copy

    def test_leftover_manifest_beside_the_driver_is_not_selected_when_the_variable_is_unset(self) -> None:
        """A stale manifest in the driver's own directory must not be picked up, and nothing is submitted."""
        copy = self.disposable_driver()
        leftover = copy.parent / LEGACY_NAME
        leftover.write_text(json.dumps(VALID_MANIFEST))
        attempt = self.root / "attempt"
        env = {key: value for key, value in os.environ.items() if key != "PI_NATIVE_ARTIFACTS_MANIFEST"}
        completed = subprocess.run(
            [sys.executable, str(copy), "--attempt-root", str(attempt)],
            capture_output=True,
            text=True,
            env=env,
        )
        output = completed.stdout + completed.stderr
        self.assertNotEqual(completed.returncode, 0, output)
        self.assertIn("PI_NATIVE_ARTIFACTS_MANIFEST", output)
        self.assertNotIn(str(leftover), output)
        self.assertFalse(attempt.exists(), "the driver reached submission without an explicit selection")

    def test_an_empty_selection_fails_rather_than_falling_back(self) -> None:
        self.select("")
        with self.assertRaises(SystemExit) as raised:
            bundled_cli_acceptance.load_artifacts_manifest()
        self.assertIn("PI_NATIVE_ARTIFACTS_MANIFEST", str(raised.exception))

    def test_a_missing_selected_manifest_fails_clearly(self) -> None:
        missing = self.root / "absent-manifest.json"
        self.select(str(missing))
        with self.assertRaises(SystemExit) as raised:
            bundled_cli_acceptance.load_artifacts_manifest()
        self.assertIn(str(missing), str(raised.exception))

    def test_a_malformed_selected_manifest_fails_clearly(self) -> None:
        malformed = self.root / "malformed-manifest.json"
        malformed.write_text("{ not json")
        self.select(str(malformed))
        with self.assertRaises(SystemExit) as raised:
            bundled_cli_acceptance.load_artifacts_manifest()
        self.assertIn(str(malformed), str(raised.exception))

    def test_a_manifest_without_a_tui_package_root_fails_clearly(self) -> None:
        incomplete = self.root / "incomplete-manifest.json"
        incomplete.write_text(json.dumps({"mode": "patched"}))
        self.select(str(incomplete))
        with self.assertRaises(SystemExit) as raised:
            bundled_cli_acceptance.load_artifacts_manifest()
        self.assertIn("tuiPackageRoot", str(raised.exception))

    def test_a_valid_explicit_selection_is_read_from_the_named_path(self) -> None:
        selected = self.root / "explicit-manifest.json"
        selected.write_text(json.dumps(VALID_MANIFEST))
        (self.root / LEGACY_NAME).write_text(json.dumps({**VALID_MANIFEST, "tuiVersion": "leftover"}))
        self.select(str(selected))
        path, manifest = bundled_cli_acceptance.load_artifacts_manifest()
        self.assertEqual(path, selected)
        self.assertEqual(manifest["tuiVersion"], "0.84.3")


if __name__ == "__main__":
    unittest.main()
