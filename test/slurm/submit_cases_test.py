"""Bootstrap tests for the repository SLURM driver. Stdlib unittest, run on a worker.

These are not Vitest cases and are not collected by any Vitest config. They exercise the driver's
parse-only validation, its failure propagation and its durability, all of which have to hold before
any real batch is trusted.

    env -u PIXI_PROJECT_MANIFEST pixi run python -m unittest discover -s test/slurm -p '*_test.py'
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

import submit_cases as driver

REPOSITORY = driver.REPOSITORY


def test_case(**overrides) -> dict:
    case = {
        "id": "unit-process-ledger",
        "kind": "test",
        "config": "vitest.config.ts",
        "file": "test/process-ledger.test.mjs",
    }
    case.update(overrides)
    case.setdefault("command", driver.build_command(case))
    return case


def task_case(**overrides) -> dict:
    case = {"id": "typecheck", "kind": "typecheck", "task": "typecheck"}
    case.update(overrides)
    case.setdefault("command", driver.build_command(case))
    return case


def install_case(**overrides) -> dict:
    case = {"id": "contained-install", "kind": "install", "packages": ["assertion-error@2.0.1"]}
    case.update(overrides)
    case.setdefault("command", driver.build_command(case))
    return case


def manifest_of(*cases) -> dict:
    return {"manifestVersion": 1, "name": "driver-unit", "description": "unit", "cases": list(cases)}


def vitest_output(tests: int, files: int = 1) -> str:
    """The two summary lines Vitest prints, in the shape the driver reads them."""
    return f"\n Test Files  {files} passed ({files})\n      Tests  {tests} passed ({tests})\n"


class ManifestValidation(unittest.TestCase):
    def test_the_shipped_manifest_validates(self):
        cases = driver.validate_manifest(driver.load_manifest(driver.DEFAULT_MANIFEST))
        self.assertTrue(cases)

    def test_a_missing_test_file_is_rejected(self):
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(test_case(file="test/does-not-exist.test.mjs")))

    def test_an_unknown_config_is_rejected(self):
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(test_case(config="vitest.rogue.config.ts")))

    def test_an_absolute_path_is_rejected(self):
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(test_case(file=str(REPOSITORY / "test/process-ledger.test.mjs"))))

    def test_a_path_escaping_the_repository_is_rejected(self):
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(test_case(file="../pi-agents-hardening-integration/test/process-ledger.test.mjs")))

    def test_duplicate_ids_are_rejected(self):
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(test_case(), test_case()))

    def test_a_declared_command_that_differs_from_the_built_command_is_rejected(self):
        smuggled = test_case()
        smuggled["command"] = [*smuggled["command"], "--reporter=json"]
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(smuggled))

    def test_an_unsupported_kind_is_rejected(self):
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of({"id": "install-pi", "kind": "install", "task": "install", "command": ["install"]}))

    def test_a_task_outside_the_kind_allowlist_is_rejected(self):
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(task_case(task="start")))

    def test_a_task_absent_from_pixi_toml_is_rejected(self):
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(task_case(id="ghost", kind="package", task="pack-check-nonexistent")))

    def test_two_pins_of_the_same_package_are_rejected(self):
        # `x@1.0.0` plus `x@2.0.0` cannot both be satisfied by one installed tree, and a verifier that
        # reads the tree once per name would certify both.
        contradictory = install_case(packages=["assertion-error@1.0.0", "assertion-error@2.0.1"])
        contradictory["command"] = driver.build_command(contradictory)
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(contradictory))

    def test_a_repeated_identical_pin_is_rejected(self):
        repeated = install_case(packages=["assertion-error@2.0.1", "assertion-error@2.0.1"])
        repeated["command"] = driver.build_command(repeated)
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(repeated))

    def test_an_install_case_is_accepted_with_exact_version_pins(self):
        cases = driver.validate_manifest(manifest_of(install_case()))
        self.assertEqual("install", cases[0]["kind"])

    def test_an_install_case_without_an_exact_version_pin_is_rejected(self):
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(install_case(packages=["assertion-error"])))

    def test_an_install_case_may_not_choose_its_own_install_root(self):
        smuggled = install_case()
        smuggled["command"] = [part.replace("{caseDirectory}/install-root", "/mnt/main0/home/gjohnson")
                               for part in smuggled["command"]]
        with self.assertRaises(driver.ManifestError):
            driver.validate_manifest(manifest_of(smuggled))

    def test_an_install_command_installs_only_into_the_case_directory(self):
        command = driver.build_command(install_case())
        self.assertEqual(["npm", "install", "--prefix", "{caseDirectory}/install-root"], command[:4])
        self.assertIn("assertion-error@2.0.1", command)
        self.assertNotIn(str(REPOSITORY / "node_modules"), " ".join(command))

    def test_validate_action_exits_nonzero_for_a_bad_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            path.write_text(json.dumps(manifest_of(test_case(file="test/does-not-exist.test.mjs"))))
            self.assertNotEqual(0, driver.main(["validate", "--manifest", str(path)]))


class BuiltCommands(unittest.TestCase):
    def test_a_test_command_keeps_the_runner_cache_out_of_node_modules(self):
        # Measured on worker 3733749_0: a plain run writes node_modules/.vite/vitest/<hash>/results.json.
        self.assertIn("--no-cache", driver.build_command(test_case()))

    def test_a_test_command_names_its_config_and_file(self):
        command = driver.build_command(test_case(testName="reaps"))
        self.assertEqual(["npx", "--no-install", "vitest", "run", "--config", "vitest.config.ts",
                          "test/process-ledger.test.mjs", "--no-cache", "-t", "reaps"], command)

    def test_a_non_test_command_is_the_declared_pixi_task_alone(self):
        self.assertEqual(["typecheck"], driver.build_command(task_case()))

    def test_the_wrapper_unsets_the_ambient_pixi_manifest_and_freezes_the_environment(self):
        argv = driver.wrap_for_project_environment(["typecheck"])
        self.assertEqual(["env", "-u", "PIXI_PROJECT_MANIFEST"], argv[:3])
        self.assertIn("--frozen", argv)
        self.assertIn(str(REPOSITORY / "pixi.toml"), argv)
        self.assertEqual("typecheck", argv[-1])


class CollectionCounting(unittest.TestCase):
    def test_a_vitest_summary_is_read_from_either_stream(self):
        self.assertEqual(3, driver.collected_tests("", "  Tests  3 passed (3)\n"))
        self.assertEqual(7, driver.collected_tests("  Tests  6 passed | 1 failed (7)\n", ""))

    def test_no_test_files_found_is_zero_collected(self):
        self.assertEqual(0, driver.collected_tests("No test files found, exiting with code 1\n", ""))

    def test_an_unreadable_summary_is_unknown_rather_than_zero(self):
        self.assertIsNone(driver.collected_tests("nothing useful here", ""))


class CaseExecution(unittest.TestCase):
    def batch(self, directory: str) -> dict:
        root = Path(directory)
        (root / "results").mkdir(parents=True, exist_ok=True)
        return {"batchId": "unit-batch", "batchDirectory": str(root), "resultsDirectory": str(root / "results")}

    def fake_runner(self, returncode: int, stdout: str, stderr: str = ""):
        def runner(argv, cwd, environment):
            return {"returncode": returncode, "stdout": stdout, "stderr": stderr}
        return runner

    def test_a_nonzero_child_raises_so_slurm_records_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                driver.run_manifest_case(test_case(), self.batch(directory),
                                         runner=self.fake_runner(1, "  Tests  1 failed (1)\n", "assertion boom"))
            result = json.loads((Path(directory) / "results/unit-process-ledger.json").read_text())
            self.assertEqual("FAILED", result["result"])
            self.assertIn("assertion boom", result["stderr"])
            self.assertEqual(1, result["returncode"])

    def test_zero_collected_tests_fail_even_with_a_zero_exit_status(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                driver.run_manifest_case(test_case(), self.batch(directory),
                                         runner=self.fake_runner(0, "No test files found, exiting with code 0\n"))
            result = json.loads((Path(directory) / "results/unit-process-ledger.json").read_text())
            self.assertEqual(0, result["collected"])
            self.assertTrue(any("collected" in failure for failure in result["failures"]))

    def test_an_unreadable_collection_count_fails_a_test_case(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                driver.run_manifest_case(test_case(), self.batch(directory), runner=self.fake_runner(0, "silence"))

    def test_a_non_test_case_needs_no_collection_count(self):
        with tempfile.TemporaryDirectory() as directory:
            result = driver.run_manifest_case(task_case(), self.batch(directory), runner=self.fake_runner(0, "ok"))
            self.assertEqual("PASSED", result["result"])
            self.assertIsNone(result["collected"])
            self.assertEqual("exit-status-only", result["collectionRule"])

    def test_a_package_case_asserts_its_own_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            case = task_case(id="package", kind="package", task="pack-check")
            with self.assertRaises(RuntimeError):
                driver.run_manifest_case(case, self.batch(directory), runner=self.fake_runner(0, "not json"))
            result = json.loads((Path(directory) / "results/package.json").read_text())
            self.assertTrue(any("artifact" in failure for failure in result["failures"]))

    def test_a_package_artifact_is_read_past_the_npm_run_script_banner(self):
        # Observed on worker 3733861_3: `npm run pack:check` writes two banner lines before the JSON.
        banner = "\n> pi-agents@0.0.2 pack:check\n> npm pack --dry-run --json\n\n"
        packed = json.dumps([{"filename": "pi-agents-0.0.2.tgz", "files": [{"path": "LICENSE"}]}])
        with tempfile.TemporaryDirectory() as directory:
            case = task_case(id="package", kind="package", task="pack-check")
            result = driver.run_manifest_case(case, self.batch(directory),
                                             runner=self.fake_runner(0, banner + packed + "\n"))
            self.assertEqual("PASSED", result["result"])
            self.assertTrue(result["artifact"]["satisfied"])

    def test_a_case_records_its_own_cleanup_and_its_protected_cache_check(self):
        with tempfile.TemporaryDirectory() as directory:
            result = driver.run_manifest_case(test_case(), self.batch(directory),
                                              runner=self.fake_runner(0, vitest_output(2)))
            self.assertEqual([], result["childProcessCleanup"]["survivors"])
            self.assertTrue(result["protectedCacheCheck"]["unchanged"])
            self.assertIn(result["cleanup"]["status"], ("CLEAN", "UNKNOWN"))

    def test_the_persisted_result_names_its_own_file(self):
        with tempfile.TemporaryDirectory() as directory:
            result = driver.run_manifest_case(test_case(), self.batch(directory),
                                              runner=self.fake_runner(0, vitest_output(2)))
            persisted = json.loads((Path(directory) / "results/unit-process-ledger.json").read_text())
            self.assertEqual(str(Path(directory) / "results/unit-process-ledger.json"), persisted["resultFile"])
            self.assertEqual(persisted["resultFile"], result["resultFile"])

    def test_a_case_runs_with_disposable_home_and_state_roots(self):
        seen = {}

        def runner(argv, cwd, environment):
            seen.update(environment)
            return {"returncode": 0, "stdout": vitest_output(2), "stderr": ""}

        with tempfile.TemporaryDirectory() as directory:
            result = driver.run_manifest_case(test_case(), self.batch(directory), runner=runner)
            case_directory = Path(result["caseDirectory"])
            for variable in ("HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
                             "XDG_STATE_HOME", "TMPDIR", "npm_config_cache"):
                self.assertTrue(Path(seen[variable]).is_relative_to(case_directory), variable)
                self.assertTrue(Path(seen[variable]).is_dir(), variable)
            ledger = Path(seen[driver.LEDGER_DIRECTORY_VARIABLE])
            self.assertTrue(ledger.is_relative_to(case_directory))
            # Not pre-created: its absence is what makes a cleanup record UNKNOWN rather than an empty pass.
            self.assertFalse(ledger.exists())
            self.assertNotIn("PIXI_PROJECT_MANIFEST", seen)
            self.assertEqual(seen["HOME"], result["environmentRoots"]["HOME"])
            self.assertEqual([str(driver.SHARED_PIXI_CACHE)], result["sharedReadOnlyPaths"])

    def test_more_than_one_collected_test_file_fails_a_single_file_case(self):
        # A stray copy of a probe anywhere under the repository makes Vitest's positional filter match
        # two files; a case that declared one file has then not run what it declared.
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                driver.run_manifest_case(test_case(), self.batch(directory),
                                         runner=self.fake_runner(0, vitest_output(2, files=2)))
            result = json.loads((Path(directory) / "results/unit-process-ledger.json").read_text())
            self.assertEqual(2, result["collectedTestFiles"])
            self.assertTrue(any("test file" in failure for failure in result["failures"]))

    def test_an_install_case_verifies_every_pinned_version_it_declared(self):
        def runner(argv, cwd, environment):
            package = Path(cwd) / "node_modules/assertion-error"
            package.mkdir(parents=True)
            (package / "package.json").write_text(json.dumps({"name": "assertion-error", "version": "2.0.1"}))
            return {"returncode": 0, "stdout": "added 1 package in 4s\n", "stderr": ""}

        with tempfile.TemporaryDirectory() as directory:
            result = driver.run_manifest_case(install_case(), self.batch(directory), runner=runner)
            self.assertEqual("PASSED", result["result"])
            self.assertEqual({"assertion-error": "2.0.1"}, result["artifact"]["installed"])
            self.assertTrue(Path(result["workingDirectory"]).is_relative_to(Path(result["caseDirectory"])))

    def test_an_install_case_fails_when_a_declared_package_is_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                driver.run_manifest_case(install_case(), self.batch(directory),
                                         runner=self.fake_runner(0, "added 0 packages\n"))
            result = json.loads((Path(directory) / "results/contained-install.json").read_text())
            self.assertTrue(any("artifact" in failure for failure in result["failures"]))

    def test_an_install_case_fails_when_the_installed_version_differs(self):
        def runner(argv, cwd, environment):
            package = Path(cwd) / "node_modules/assertion-error"
            package.mkdir(parents=True)
            (package / "package.json").write_text(json.dumps({"name": "assertion-error", "version": "1.0.0"}))
            return {"returncode": 0, "stdout": "added 1 package\n", "stderr": ""}

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                driver.run_manifest_case(install_case(), self.batch(directory), runner=runner)


class Verdicts(unittest.TestCase):
    def passing_result(self, **overrides) -> dict:
        result = {"result": "PASSED", "failures": [], "cleanup": {"status": "CLEAN", "survivors": []}}
        result.update(overrides)
        return result

    def test_all_four_conditions_pass(self):
        verdict, reasons = driver.verdict_for("COMPLETED", "0:0", self.passing_result())
        self.assertEqual(("PASSED", []), (verdict, reasons))

    def test_a_missing_result_file_is_never_a_pass(self):
        verdict, _ = driver.verdict_for("COMPLETED", "0:0", None)
        self.assertEqual("FAILED", verdict)

    def test_an_unknown_cleanup_record_is_never_a_pass(self):
        verdict, reasons = driver.verdict_for("COMPLETED", "0:0", self.passing_result(cleanup={"status": "UNKNOWN", "survivors": None}))
        self.assertEqual("FAILED", verdict)
        self.assertTrue(any("cleanup" in reason for reason in reasons))

    def test_a_nonterminal_state_or_nonzero_exit_code_is_never_a_pass(self):
        self.assertEqual("FAILED", driver.verdict_for("RUNNING", "0:0", self.passing_result())[0])
        self.assertEqual("FAILED", driver.verdict_for("FAILED", "1:0", self.passing_result())[0])


class Durability(unittest.TestCase):
    def test_a_record_is_write_once(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "record.json"
            driver.write_json_durable(path, {"first": True})
            with self.assertRaises(FileExistsError):
                driver.write_json_durable(path, {"second": True})
            self.assertEqual({"first": True}, json.loads(path.read_text()))

    def test_a_replayed_record_lands_beside_the_first_one(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "record.json"
            driver.write_json_durable_attempt(path, {"attempt": 1})
            second = driver.write_json_durable_attempt(path, {"attempt": 2})
            self.assertEqual(str(path.with_name("record.attempt-2.json")), str(second))

    def test_the_submission_intent_is_recorded_before_any_job_id_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = driver.claim_batch_directory(Path(directory), "unit-batch")
            intent = driver.record_submission_intent(batch_directory, "unit-batch", driver.DEFAULT_MANIFEST,
                                                     driver.validate_manifest(driver.load_manifest(driver.DEFAULT_MANIFEST)))
            written = json.loads((batch_directory / "submission-intent.json").read_text())
            self.assertIsNone(written["jobIds"])
            self.assertEqual(intent["manifestSha256"], driver.digest_of(driver.DEFAULT_MANIFEST))
            self.assertTrue(written["caseIds"])

    def test_a_batch_directory_is_claimed_exclusively(self):
        with tempfile.TemporaryDirectory() as directory:
            driver.claim_batch_directory(Path(directory), "unit-batch")
            with self.assertRaises(FileExistsError):
                driver.claim_batch_directory(Path(directory), "unit-batch")


class ProtectedPathFingerprint(unittest.TestCase):
    def test_the_fingerprint_covers_installed_dependency_identity(self):
        inventory = driver.protected_inventory()
        self.assertIn(driver.NPM_DEPENDENCY_IDENTITY, inventory)
        self.assertIn(driver.PIXI_ENVIRONMENT_IDENTITY, inventory)
        self.assertEqual("4.1.9", inventory[driver.NPM_DEPENDENCY_IDENTITY]["vitest"])
        self.assertTrue(inventory[driver.PIXI_ENVIRONMENT_IDENTITY])
        self.assertIn("node_modules/.vite", inventory)

    def test_a_changed_dependency_version_is_reported_as_changed(self):
        before = driver.protected_inventory()
        after = json.loads(json.dumps(before))
        after[driver.NPM_DEPENDENCY_IDENTITY]["vitest"] = "9.9.9"
        difference = driver.protected_difference(before, after)
        self.assertFalse(difference["unchanged"])
        self.assertIn(driver.NPM_DEPENDENCY_IDENTITY, difference["changed"])


class ReplayAdjudication(unittest.TestCase):
    def batch_with_attempts(self, directory: str, *results) -> dict:
        root = Path(directory)
        (root / "results").mkdir(parents=True, exist_ok=True)
        for index, payload in enumerate(results, start=1):
            name = "case.json" if index == 1 else f"case.attempt-{index}.json"
            (root / "results" / name).write_text(json.dumps(payload))
        return {"batchId": "unit-batch", "batchDirectory": str(root),
                "resultsDirectory": str(root / "results"), "logsFolder": str(root / "logs"),
                "jobIds": ["1_0"], "jobs": [{"caseId": "case", "kind": "test", "jobId": "1_0"}]}

    def passing(self, **overrides) -> dict:
        record = {"result": "PASSED", "failures": [], "cleanup": {"status": "CLEAN", "survivors": []},
                  "returncode": 0, "attempt": 1}
        record.update(overrides)
        return record

    def sacct_reader(self, state="COMPLETED", exit_code="0:0"):
        def reader(job_id):
            return {"returncode": 0, "stdout": f"{job_id}|name|{state}|{exit_code}|s|e|1|node\n", "stderr": ""}
        return reader

    def test_a_single_attempt_case_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            record = self.batch_with_attempts(directory, self.passing())
            path = Path(directory) / "batch-record.json"
            path.write_text(json.dumps(record))
            report = driver.collect(path, sacct_reader=self.sacct_reader())
            self.assertEqual("PASSED", report["entries"][0]["verdict"])
            self.assertEqual(1, len(report["entries"][0]["attempts"]))

    def test_a_second_attempt_record_is_never_a_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            record = self.batch_with_attempts(directory, self.passing(),
                                              self.passing(result="FAILED", failures=["boom"], attempt=2))
            path = Path(directory) / "batch-record.json"
            path.write_text(json.dumps(record))
            report = driver.collect(path, sacct_reader=self.sacct_reader())
            entry = report["entries"][0]
            self.assertEqual("FAILED", entry["verdict"])
            self.assertEqual(2, len(entry["attempts"]))
            self.assertTrue(any("attempt" in reason for reason in entry["verdictReasons"]))

    def test_every_attempt_record_is_reported_with_its_own_result(self):
        with tempfile.TemporaryDirectory() as directory:
            record = self.batch_with_attempts(directory,
                                              self.passing(result="FAILED", failures=["first"]),
                                              self.passing(attempt=2))
            path = Path(directory) / "batch-record.json"
            path.write_text(json.dumps(record))
            report = driver.collect(path, sacct_reader=self.sacct_reader())
            attempts = report["entries"][0]["attempts"]
            self.assertEqual(["FAILED", "PASSED"], [attempt["result"] for attempt in attempts])
            self.assertEqual("FAILED", report["entries"][0]["verdict"])

    def test_one_record_from_a_restarted_task_is_never_a_pass(self):
        # Slurm can requeue after the case directory is claimed but before any result is written. The
        # restarted worker then takes the base `<id>.json` name, so the file name alone says "attempt 1".
        with tempfile.TemporaryDirectory() as directory:
            record = self.batch_with_attempts(directory, self.passing(slurmRestartCount="1"))
            path = Path(directory) / "batch-record.json"
            path.write_text(json.dumps(record))
            entry = driver.collect(path, sacct_reader=self.sacct_reader())["entries"][0]
            self.assertEqual("FAILED", entry["verdict"])
            self.assertTrue(any("restart" in reason for reason in entry["verdictReasons"]))

    def test_one_record_whose_persisted_attempt_is_not_the_first_is_never_a_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            record = self.batch_with_attempts(directory, self.passing(attempt=2))
            path = Path(directory) / "batch-record.json"
            path.write_text(json.dumps(record))
            entry = driver.collect(path, sacct_reader=self.sacct_reader())["entries"][0]
            self.assertEqual("FAILED", entry["verdict"])
            self.assertTrue(any("attempt" in reason for reason in entry["verdictReasons"]))

    def test_attempt_identity_comes_from_the_record_not_only_from_the_file_name(self):
        with tempfile.TemporaryDirectory() as directory:
            self.batch_with_attempts(directory, self.passing(attempt=3, slurmRestartCount="2"))
            attempts = driver.attempt_records(Path(directory) / "results", "case")
            self.assertEqual(1, attempts[0]["fileAttempt"])
            self.assertEqual(3, attempts[0]["recordedAttempt"])
            self.assertEqual(3, attempts[0]["attempt"])

    def test_an_unreadable_restart_count_is_never_a_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            record = self.batch_with_attempts(directory, self.passing(slurmRestartCount="not-a-number"))
            path = Path(directory) / "batch-record.json"
            path.write_text(json.dumps(record))
            entry = driver.collect(path, sacct_reader=self.sacct_reader())["entries"][0]
            self.assertEqual("FAILED", entry["verdict"])

    def test_one_first_attempt_record_with_no_restart_still_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            record = self.batch_with_attempts(directory, self.passing(slurmRestartCount="0"))
            path = Path(directory) / "batch-record.json"
            path.write_text(json.dumps(record))
            entry = driver.collect(path, sacct_reader=self.sacct_reader())["entries"][0]
            self.assertEqual(("PASSED", []), (entry["verdict"], entry["verdictReasons"]))


class SubmissionGapReconciliation(unittest.TestCase):
    def claimed_batch(self, directory: str, batch_id="unit-batch") -> Path:
        batch_directory = driver.claim_batch_directory(Path(directory), batch_id)
        cases = driver.validate_manifest(driver.load_manifest(driver.DEFAULT_MANIFEST))
        driver.record_submission_intent(batch_directory, batch_id, driver.DEFAULT_MANIFEST, cases)
        return batch_directory

    def empty_sacct(self, name):
        return {"returncode": 0, "stdout": "JobID|JobName|State|ExitCode\n", "stderr": ""}

    def test_a_recorded_batch_needs_no_reconciliation(self):
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory)
            (batch_directory / "batch-record.json").write_text(json.dumps({"jobIds": ["7_0"]}))
            report = driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            self.assertEqual("RECORDED", report["reconciliationState"])

    def test_job_ids_are_reconstructed_from_submitit_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory)
            for task in range(4):
                (batch_directory / f"logs/3999999_{task}_submitted.pkl").write_bytes(b"")
            (batch_directory / "logs/3999999_submission.sh").write_text("#SBATCH --array=0-3%4\n")
            report = driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            self.assertEqual("RECONCILED", report["reconciliationState"])
            self.assertEqual(["3999999_0", "3999999_1", "3999999_2", "3999999_3"], report["jobIds"])
            self.assertEqual(["unit-process-ledger", "experiment-collection-probe", "typecheck", "package"],
                             [job["caseId"] for job in report["jobs"]])
            written = json.loads((batch_directory / "reconciled-batch-record.json").read_text())
            self.assertEqual(report["jobIds"], written["jobIds"])

    def test_a_reconciled_record_carries_what_wait_and_collect_need(self):
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory)
            for task in range(4):
                (batch_directory / f"logs/3999999_{task}_submitted.pkl").write_bytes(b"")
            driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            written = json.loads((batch_directory / "reconciled-batch-record.json").read_text())
            for key in ("batchId", "batchDirectory", "resultsDirectory", "logsFolder", "jobIds", "jobs"):
                self.assertIn(key, written)

    def test_job_ids_are_reconstructed_from_sacct_when_no_artifact_survived(self):
        def sacct_by_name(name):
            rows = "".join(f"3999998_{task}|{name}|COMPLETED|0:0\n" for task in range(4))
            return {"returncode": 0, "stdout": f"JobID|JobName|State|ExitCode\n{rows}", "stderr": ""}

        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory)
            report = driver.reconcile(batch_directory, sacct_by_name=sacct_by_name)
            self.assertEqual("RECONCILED", report["reconciliationState"])
            self.assertEqual(["3999998_0", "3999998_1", "3999998_2", "3999998_3"], report["jobIds"])

    def single_case_batch(self, directory: str, batch_id="single-batch") -> Path:
        batch_directory = driver.claim_batch_directory(Path(directory), batch_id)
        cases = [driver.validate_manifest(driver.load_manifest(driver.DEFAULT_MANIFEST))[1]]
        driver.record_submission_intent(batch_directory, batch_id, driver.DEFAULT_MANIFEST, cases)
        return batch_directory

    def test_a_single_job_submission_is_reconciled_from_its_artifact(self):
        # Observed on job 3734496: a one-case batch is not an array, so submitit writes
        # `<jobid>_submitted.pkl` and the job id has no task component.
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.single_case_batch(directory)
            (batch_directory / "logs/3734496_submitted.pkl").write_bytes(b"")
            (batch_directory / "logs/3734496_submission.sh").write_text("#SBATCH --job-name=x\n")
            report = driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            self.assertEqual("RECONCILED", report["reconciliationState"])
            self.assertEqual(["3734496"], report["jobIds"])

    def test_a_single_job_submission_is_reconciled_from_sacct(self):
        def sacct_by_name(name):
            return {"returncode": 0, "stdout": f"JobID|JobName|State|ExitCode\n3734496|{name}|PENDING|0:0\n",
                    "stderr": ""}

        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.single_case_batch(directory)
            report = driver.reconcile(batch_directory, sacct_by_name=sacct_by_name)
            self.assertEqual("RECONCILED", report["reconciliationState"])
            self.assertEqual(["3734496"], report["jobIds"])

    def test_array_artifacts_are_ordered_by_task_index_not_by_name(self):
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory)
            for task in (10, 2, 0, 1):
                (batch_directory / f"logs/3999995_{task}_submitted.pkl").write_bytes(b"")
            self.assertEqual(["3999995_0", "3999995_1", "3999995_2", "3999995_10"],
                             driver.job_ids_from_artifacts(batch_directory / "logs"))

    def test_a_partial_submission_window_is_unknown_rather_than_reconciled(self):
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory)
            (batch_directory / "logs/3999997_0_submitted.pkl").write_bytes(b"")
            report = driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            self.assertEqual("UNKNOWN_SUBMISSION_GAP", report["reconciliationState"])
            self.assertIsNone(report["jobIds"])

    def test_an_empty_submission_window_is_unknown_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory)
            report = driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            self.assertEqual("UNKNOWN_SUBMISSION_GAP", report["reconciliationState"])
            written = json.loads((batch_directory / "reconciled-batch-record.json").read_text())
            self.assertIsNone(written["jobIds"])
            self.assertNotEqual(0, driver.main(["reconcile", "--batch-directory", str(batch_directory)]))

    def test_an_unknown_reconciliation_keeps_the_submit_guard_closed(self):
        # Writing the UNKNOWN record is not closure: it says an operator decision is required, so the
        # next submit must still be refused rather than starting a second unaccounted batch.
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory, batch_id="gap-batch")
            report = driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            self.assertEqual("UNKNOWN_SUBMISSION_GAP", report["reconciliationState"])
            with self.assertRaises(driver.UnreconciledSubmissionGap):
                driver.assert_no_unreconciled_gap(Path(directory))
            self.assertNotEqual(0, driver.main(["submit", "--manifest", str(driver.DEFAULT_MANIFEST),
                                                "--execution-root", directory]))

    def test_the_latest_reconciliation_state_decides_and_attempts_order_numerically(self):
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory, batch_id="gap-batch")
            driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            self.assertEqual("UNKNOWN_SUBMISSION_GAP", driver.latest_reconciliation_state(batch_directory))
            for task in range(4):
                (batch_directory / f"logs/3999994_{task}_submitted.pkl").write_bytes(b"")
            second = driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            self.assertEqual("RECONCILED", second["reconciliationState"])
            # `reconciled-batch-record.attempt-2.json` sorts before the base name lexically, so the
            # latest record has to be found by attempt number.
            self.assertEqual("RECONCILED", driver.latest_reconciliation_state(batch_directory))
            driver.assert_no_unreconciled_gap(Path(directory))

    def test_reconciliation_is_write_once(self):
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory)
            driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            second = driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            self.assertTrue(second["reconciliationRecord"].endswith("attempt-2.json"))

    def test_submit_refuses_an_execution_root_holding_an_unreconciled_gap(self):
        with tempfile.TemporaryDirectory() as directory:
            self.claimed_batch(directory, batch_id="gap-batch")
            with self.assertRaises(driver.UnreconciledSubmissionGap):
                driver.assert_no_unreconciled_gap(Path(directory))
            self.assertNotEqual(0, driver.main(["submit", "--manifest", str(driver.DEFAULT_MANIFEST),
                                                "--execution-root", directory]))

    def test_a_reconciled_gap_no_longer_blocks_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            batch_directory = self.claimed_batch(directory, batch_id="gap-batch")
            for task in range(4):
                (batch_directory / f"logs/3999996_{task}_submitted.pkl").write_bytes(b"")
            driver.reconcile(batch_directory, sacct_by_name=self.empty_sacct)
            driver.assert_no_unreconciled_gap(Path(directory))


class ExperimentCollectionSeparation(unittest.TestCase):
    def test_the_default_config_and_the_experiment_config_differ_only_in_include(self):
        default = (REPOSITORY / "vitest.config.ts").read_text()
        experiment = (REPOSITORY / "vitest.experiment.config.ts").read_text()
        self.assertIn('include: ["**/*.test.{ts,mjs}"]', default)
        self.assertIn('include: ["**/*.experiment.mjs"]', experiment)
        self.assertEqual(
            default.replace('include: ["**/*.test.{ts,mjs}"]', "INCLUDE"),
            experiment.replace('include: ["**/*.experiment.mjs"]', "INCLUDE"),
        )

    def test_no_experiment_probe_is_named_like_a_default_suite_file(self):
        probes = sorted(path.name for path in (REPOSITORY / "test/slurm").glob("*.experiment.mjs"))
        self.assertTrue(probes)
        self.assertFalse([name for name in probes if ".test." in name])


if __name__ == "__main__":
    os.chdir(REPOSITORY)
    unittest.main(verbosity=2)
