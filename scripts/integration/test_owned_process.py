import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("owned_process", Path(__file__).with_name("owned_process.py"))
owned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned)

CHILD = r'''
import json,os,signal,subprocess,sys,time
from pathlib import Path
directory,role,stubborn,root_exit=sys.argv[1:]
directory=Path(directory)
if stubborn=='1':signal.signal(signal.SIGTERM,signal.SIG_IGN)
(directory/(role+'.json')).write_text(json.dumps({'pid':os.getpid(),'ppid':os.getppid()}))
if role=='late-root':
 while not (directory/'spawn.request').exists():time.sleep(.01)
 try:
  subprocess.Popen([sys.executable,'-u',__file__,str(directory),'late-child',stubborn,root_exit])
  outcome={'created':True}
 except OSError as error:outcome={'created':False,'error':str(error)}
 (directory/'spawn-result.json').write_text(json.dumps(outcome))
if role in ('root','child'):
 next_role='child' if role=='root' else 'grandchild'
 subprocess.Popen([sys.executable,'-u',__file__,str(directory),next_role,stubborn,root_exit])
if role=='root' and root_exit=='1':
 deadline=time.monotonic()+10
 while not (directory/'grandchild.json').exists():
  if time.monotonic()>deadline:raise RuntimeError('descendant startup timeout')
  time.sleep(.01)
 sys.exit(0)
time.sleep(120)
'''

def alive(pid):
    if os.name == "nt":
        import _winapi
        try:
            handle = _winapi.OpenProcess(0x1000 | 0x100000, False, pid)
        except OSError:
            return False
        try:
            return _winapi.WaitForSingleObject(handle, 0) != _winapi.WAIT_OBJECT_0
        finally:
            _winapi.CloseHandle(handle)
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


class OwnedProcessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-process-test-")
        self.directory = Path(self.temporary.name)
        self.script = self.directory / "children.py"
        self.script.write_text(CHILD, encoding="utf-8")
        self.output = (self.directory / "output.log").open("w", encoding="utf-8")
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            result = process.stop(timeout=5)
            self.assertTrue(result["stopped"], result)
        self.output.close()
        self.temporary.cleanup()

    def start(self, name, *, stubborn=False, root_exit=False, role="root"):
        directory = self.directory / name
        directory.mkdir()
        process = owned.OwnedProcess([sys.executable, "-u", self.script, directory, role,
                                      "1" if stubborn else "0", "1" if root_exit else "0"],
                                     cwd=self.directory, env=dict(os.environ), stdout=self.output)
        self.processes.append(process)
        return process, directory

    def wait_members(self, directory, roles=("root", "child", "grandchild")):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                return [json.loads((directory / (role + ".json")).read_text())["pid"] for role in roles]
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(.02)
        self.fail("Owned child/grandchild did not start: " + (self.directory / "output.log").read_text())

    def test_actual_child_and_grandchild_are_contained_and_unrelated_command_survives(self):
        process, directory = self.start("tree")
        pids = self.wait_members(directory)
        other, other_directory = self.start("independent", role="single")
        other_pid = self.wait_members(other_directory, ("single",))[0]
        result = process.stop(timeout=5)
        self.assertTrue(result["stopped"], result)
        self.assertTrue(result["rootStopped"] and result["descendantsStopped"])
        self.assertTrue(all(not alive(pid) for pid in pids))
        self.assertTrue(alive(other_pid))
        self.assertIsNone(other.poll())

    def test_actual_stubborn_tree_is_force_stopped_within_bound(self):
        process, directory = self.start("stubborn", stubborn=True)
        pids = self.wait_members(directory)
        before = time.monotonic()
        result = process.stop(timeout=3)
        self.assertLess(time.monotonic() - before, 4)
        self.assertTrue(result["stopped"], result)
        self.assertTrue(result["forced"])
        self.assertTrue(all(not alive(pid) for pid in pids))

    def test_normal_parent_exit_does_not_release_surviving_descendants(self):
        process, directory = self.start("orphaned", root_exit=True)
        pids = self.wait_members(directory)
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertTrue(alive(pids[1]) and alive(pids[2]))
        result = process.stop(timeout=5)
        self.assertTrue(result["stopped"], result)
        self.assertEqual(process.returncode, 0)
        self.assertTrue(all(not alive(pid) for pid in pids))

    def test_wait_timeout_does_not_destroy_ownership_and_stop_is_idempotent(self):
        process, directory = self.start("wait", role="single")
        self.wait_members(directory, ("single",))
        with self.assertRaises(subprocess.TimeoutExpired):
            process.wait(timeout=.01)
        self.assertTrue(process.stop(timeout=3)["stopped"])
        self.assertTrue(process.stop(timeout=3)["stopped"])

    def test_failed_cleanup_is_reported_without_replacing_the_callers_exception(self):
        process, directory = self.start("failure", role="single")
        self.wait_members(directory, ("single",))
        original = RuntimeError("original command timeout")
        with patch.object(owned, "_job_active", side_effect=OSError("query denied")) if os.name == "nt" else \
                patch.object(process, "_posix_live_members", side_effect=OSError("query denied")):
            try:
                raise original
            except RuntimeError as caught:
                result = process.stop(timeout=1)
                self.assertIs(caught, original)
                self.assertFalse(result["stopped"])
                self.assertIn("query denied", result["errors"][0])
        self.assertIsNone(process.poll())

    def test_start_failure_keeps_original_error_and_reports_suspended_cleanup_on_windows(self):
        with self.assertRaises(OSError) as caught:
            owned.OwnedProcess([str(self.directory / "missing-executable")], stdout=self.output)
        if os.name == "nt":
            self.assertTrue(caught.exception.owned_process_cleanup["stopped"])

    @unittest.skipUnless(os.name == "nt", "Windows native job assignment")
    def test_assignment_failure_kills_suspended_child_before_any_user_code_runs(self):
        directory = self.directory / "never-ran"
        directory.mkdir()
        with patch.object(owned, "_assign_job", side_effect=OSError("injected assignment failure")), self.assertRaisesRegex(OSError, "injected") as caught:
            owned.OwnedProcess([sys.executable, "-u", self.script, directory, "root", "0", "0"], stdout=self.output)
        self.assertTrue(caught.exception.owned_process_cleanup["stopped"])
        self.assertEqual(list(directory.iterdir()), [])

    @unittest.skipUnless(os.name == "nt", "Windows native job creation seal")
    def test_cleanup_prevents_late_spawn_after_job_members_are_about_to_be_enumerated(self):
        process, directory = self.start("late-spawn", role="late-root")
        self.wait_members(directory, ("late-root",))
        enumerate_handles = owned._job_process_handles
        outcomes = []
        def request_late_child(job):
            (directory / "spawn.request").write_text("request after creation seal")
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try:
                    outcomes.append(json.loads((directory / "spawn-result.json").read_text()))
                    break
                except (FileNotFoundError, json.JSONDecodeError):
                    time.sleep(.01)
            return enumerate_handles(job)
        with patch.object(owned, "_job_process_handles", side_effect=request_late_child):
            result = process.stop(timeout=5)
        self.assertTrue(result["stopped"], result)
        self.assertEqual(len(outcomes), 1)
        self.assertFalse(outcomes[0]["created"])
        self.assertFalse((directory / "late-child.json").exists())

    @unittest.skipUnless(os.name == "nt", "Windows native handle cleanup")
    def test_temporary_handle_close_failure_attempts_every_handle_then_retries_and_preserves_error(self):
        api = owned._winapi
        duplicate, create, close = api.DuplicateHandle, api.CreateProcess, api.CloseHandle
        tracked, closed, thread, attempts = [], [], [], []
        def duplicate_hook(*args):
            handle = duplicate(*args)
            tracked.append(handle)
            return handle
        def create_hook(*args):
            value = create(*args)
            thread.append(value[1])
            tracked.append(value[1])
            return value
        original = OSError("injected first thread close failure")
        def close_hook(handle):
            attempts.append(handle)
            if thread and handle == thread[0] and attempts.count(handle) == 1:
                raise original
            close(handle)
            closed.append(handle)
        with patch.object(api, "DuplicateHandle", side_effect=duplicate_hook), \
                patch.object(api, "CreateProcess", side_effect=create_hook), \
                patch.object(api, "CloseHandle", side_effect=close_hook), self.assertRaises(OSError) as caught:
            owned.OwnedProcess([sys.executable, "-c", "import time;time.sleep(120)"], stdout=self.output)
        self.assertIs(caught.exception, original)
        self.assertTrue(caught.exception.owned_process_cleanup["stopped"])
        self.assertTrue(all(handle in closed for handle in tracked))
        self.assertEqual(attempts[:3], [thread[0], tracked[0], tracked[1]])
        self.assertEqual(attempts[3], thread[0])

    @unittest.skipUnless(os.name == "nt", "Windows native handle cleanup")
    def test_job_close_failure_does_not_skip_root_handle_and_exact_failed_job_is_retried(self):
        process, directory = self.start("close-retry", role="single")
        self.wait_members(directory, ("single",))
        job, root_handle = process._job, process._handle
        close = owned._winapi.CloseHandle
        attempts, closed = [], []
        def close_hook(handle):
            attempts.append(handle)
            if handle == job and attempts.count(job) == 1:
                raise OSError("injected first job close failure")
            close(handle)
            closed.append(handle)
        with patch.object(owned._winapi, "CloseHandle", side_effect=close_hook):
            result = process.stop(timeout=5)
        self.assertTrue(result["stopped"], result)
        self.assertIn(root_handle, closed)
        self.assertIn(job, closed)
        self.assertLess(attempts.index(root_handle), len(attempts) - 1)
        self.assertEqual(attempts[-1], job)

    @unittest.skipUnless(os.name == "nt", "Windows native handle cleanup")
    def test_close_helper_retains_exact_persistent_failures_and_attempts_other_handles(self):
        attempts = []
        def close_hook(handle):
            attempts.append(handle)
            if handle == 111:
                raise OSError("persistent close failure")
        with patch.object(owned._winapi, "CloseHandle", side_effect=close_hook):
            remaining, failures = owned._close_handles([111, 222, 333])
        self.assertEqual(attempts, [111, 222, 333, 111])
        self.assertEqual(remaining, [111])
        self.assertEqual(len(failures), 2)


if __name__ == "__main__":
    unittest.main()
