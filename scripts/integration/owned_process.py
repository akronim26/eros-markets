"""Bounded ownership of one foreground command and its inherited descendants.

Windows children enter a kill-on-close Job Object before their first instruction.
POSIX children start in a dedicated session/process group. No PID-name searches,
system settings, shared sessions or unrelated processes are modified.
"""
import math
import os
from pathlib import Path
import signal
import subprocess
import time


if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    import msvcrt
    import _winapi

    class _BasicLimits(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                    ("flags", wintypes.DWORD), ("minimum_ws", ctypes.c_size_t), ("maximum_ws", ctypes.c_size_t),
                    ("active_limit", wintypes.DWORD), ("affinity", ctypes.c_size_t),
                    ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]

    class _IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

    class _ExtendedLimits(ctypes.Structure):
        _fields_ = [("basic", _BasicLimits), ("io", _IoCounters),
                    ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                    ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]

    class _Accounting(ctypes.Structure):
        _fields_ = [(name, ctypes.c_longlong) for name in ("user_time", "kernel_time", "period_user", "period_kernel")] + [
            ("page_faults", wintypes.DWORD), ("total", wintypes.DWORD),
            ("active", wintypes.DWORD), ("terminated", wintypes.DWORD)]

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    for _name, _arguments, _result in [
        ("CreateJobObjectW", [ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        ("SetInformationJobObject", [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        ("AssignProcessToJobObject", [wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        ("QueryInformationJobObject", [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
        ("TerminateJobObject", [wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        ("IsProcessInJob", [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)], wintypes.BOOL),
        ("ResumeThread", [wintypes.HANDLE], wintypes.DWORD),
    ]:
        _function = getattr(_kernel, _name)
        _function.argtypes, _function.restype = _arguments, _result

    def _assign_job(job, process):
        if not _kernel.AssignProcessToJobObject(job, process):
            raise ctypes.WinError(ctypes.get_last_error())

    def _close_handles(handles):
        """Attempt every exact owned handle, then retry failures once."""
        pending, errors = list(dict.fromkeys(handles)), []
        for _attempt in range(2):
            failed = []
            for handle in pending:
                try:
                    _winapi.CloseHandle(handle)
                except OSError as error:
                    errors.append(error)
                    failed.append(handle)
            pending = failed
            if not pending:
                break
        return pending, errors

    def _job_active(job):
        result = _Accounting()
        if not _kernel.QueryInformationJobObject(job, 1, ctypes.byref(result), ctypes.sizeof(result), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return result.active

    def _seal_job_creation(job):
        # At cleanup only: with at least one existing process, limit1 rejects
        # every new association. Existing members are retained for exact waits.
        # https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information
        limits = _ExtendedLimits()
        limits.basic.flags = 0x2000 | 0x8
        limits.basic.active_limit = 1
        if not _kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())

    def _job_process_handles(job):
        capacity = 32
        while capacity <= 65536:
            buffer = ctypes.create_string_buffer(8 + capacity * ctypes.sizeof(ctypes.c_size_t))
            if _kernel.QueryInformationJobObject(job, 3, buffer, len(buffer), None):
                count = ctypes.c_uint32.from_buffer(buffer, 4).value
                pids = (ctypes.c_size_t * count).from_buffer(buffer, 8)
                handles, opened = [], []
                try:
                    for pid in pids:
                        try:
                            handle = _winapi.OpenProcess(0x1000 | 0x100000, False, pid)
                        except OSError as error:
                            if error.winerror == 87:  # Exited between enumeration and opening.
                                continue
                            raise
                        opened.append(handle)
                        belongs = wintypes.BOOL()
                        if not _kernel.IsProcessInJob(handle, job, ctypes.byref(belongs)):
                            raise ctypes.WinError(ctypes.get_last_error())
                        if belongs.value:
                            handles.append(handle)
                        else:  # A reused PID is not an owned process handle.
                            _winapi.CloseHandle(handle)
                            opened.remove(handle)
                    return handles
                except BaseException as error:
                    remaining, failures = _close_handles(opened)
                    error.owned_handles = remaining
                    for failure in failures:
                        error.add_note("Job enumeration handle cleanup: " + str(failure))
                    raise
            if ctypes.get_last_error() != 234:  # ERROR_MORE_DATA
                raise ctypes.WinError(ctypes.get_last_error())
            capacity *= 2
        raise OSError("Owned job process enumeration exceeded its65536-process bound")


class OwnedProcess:
    """Small Popen-compatible adapter; call stop() even after a normal root exit.

    stop() reports cleanup failures instead of replacing the caller's original
    command exception. The caller must refuse a stopped-status claim unless its
    returned `stopped` field is true. POSIX containment applies to the dedicated
    session/group; deliberately daemonizing children are not a supported command.
    """
    def __init__(self, argv, *, cwd=None, env=None, stdout):
        if isinstance(argv, (str, bytes)) or not argv:
            raise ValueError("Owned commands require an argument vector")
        self.args = [str(value) for value in argv]
        self.returncode = None
        self.pid = None
        self._process = None
        self._handle = None
        self._job = None
        self._pending_handles = []
        self._stopped = False
        if os.name == "nt":
            self._start_windows(cwd, env, stdout)
        else:
            self._process = subprocess.Popen(self.args, cwd=cwd, env=env, stdout=stdout,
                                             stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                             start_new_session=True, close_fds=True)
            self.pid = self._process.pid

    def _start_windows(self, cwd, env, stdout):
        inherited, thread, startup_error = [], None, None
        try:
            self._job = _kernel.CreateJobObjectW(None, None)
            if not self._job:
                raise ctypes.WinError(ctypes.get_last_error())
            limits = _ExtendedLimits()
            limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway flags.
            if not _kernel.SetInformationJobObject(self._job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise ctypes.WinError(ctypes.get_last_error())
            current = _winapi.GetCurrentProcess()
            with open(os.devnull, "rb") as null_input:
                for descriptor in (null_input.fileno(), stdout.fileno()):
                    inherited.append(_winapi.DuplicateHandle(current, msvcrt.get_osfhandle(descriptor), current,
                                                            0, True, _winapi.DUPLICATE_SAME_ACCESS))
                startup = subprocess.STARTUPINFO()
                startup.dwFlags = _winapi.STARTF_USESTDHANDLES | _winapi.STARTF_USESHOWWINDOW
                startup.wShowWindow = 0
                startup.hStdInput, startup.hStdOutput = inherited
                startup.hStdError = inherited[1]
                startup.lpAttributeList = {"handle_list": inherited}
                self._handle, thread, self.pid, _tid = _winapi.CreateProcess(
                    None, subprocess.list2cmdline(self.args), None, None, True,
                    _winapi.CREATE_NO_WINDOW | 0x4 | 0x400,  # suspended + Unicode environment
                    env, None if cwd is None else str(cwd), startup)
            # Assignment precedes ResumeThread, so no child can escape an uncontained parent.
            _assign_job(self._job, self._handle)
            if _kernel.ResumeThread(thread) != 1:
                raise ctypes.WinError(ctypes.get_last_error())
        except BaseException as error:
            startup_error = error
            cleanup = {"stopped": self._handle is None, "errors": [], "phase": "suspended-startup", "pid": self.pid}
            if self._handle is not None:
                try:
                    _winapi.TerminateProcess(self._handle, 1)
                    cleanup["stopped"] = _winapi.WaitForSingleObject(self._handle, 10000) == _winapi.WAIT_OBJECT_0
                    if not cleanup["stopped"]:
                        cleanup["errors"].append("Suspended child did not terminate within10s")
                except OSError as failure:
                    cleanup["errors"].append(str(failure))
            error.owned_process_cleanup = cleanup
            if not cleanup["stopped"]:
                error.add_note("Owned suspended-child cleanup was not confirmed: " + str(cleanup))
            try:
                self._close_windows()
            except OSError as failure:
                cleanup["errors"].append(str(failure))
                cleanup["stopped"] = False
                error.add_note("Native ownership handle cleanup failed: " + str(failure))
            raise
        finally:
            remaining, failures = _close_handles(([thread] if thread is not None else []) + inherited)
            self._pending_handles.extend(remaining)
            if failures:
                failure = failures[0]
                if startup_error is not None:
                    startup_error.owned_process_cleanup["errors"].extend(str(item) for item in failures)
                    if remaining:
                        startup_error.owned_process_cleanup["stopped"] = False
                    startup_error.add_note("Native startup handle cleanup encountered errors: " + str(failures))
                else:
                    failure.owned_process_cleanup = self.stop(timeout=10)
                    failure.owned_process_cleanup["startupHandleCloseErrors"] = [str(item) for item in failures]
                    raise failure

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        if os.name != "nt":
            self.returncode = self._process.poll()
        elif self._handle is not None and _winapi.WaitForSingleObject(self._handle, 0) == _winapi.WAIT_OBJECT_0:
            self.returncode = _winapi.GetExitCodeProcess(self._handle)
        return self.returncode

    def wait(self, timeout=None):
        if os.name != "nt":
            self.returncode = self._process.wait(timeout=timeout)
        elif self.poll() is None:
            milliseconds = 0xFFFFFFFF if timeout is None else max(0, math.ceil(timeout * 1000))
            if _winapi.WaitForSingleObject(self._handle, milliseconds) != _winapi.WAIT_OBJECT_0:
                raise subprocess.TimeoutExpired(self.args, timeout)
            self.returncode = _winapi.GetExitCodeProcess(self._handle)
        return self.returncode

    def _posix_live_members(self):
        proc = Path("/proc")
        if proc.is_dir():
            members = []
            for entry in proc.iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    fields = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
                    if int(fields[2]) == self.pid and int(fields[3]) == self.pid and fields[0] != "Z":
                        members.append(int(entry.name))
                except (FileNotFoundError, ProcessLookupError):
                    continue
            return members
        # Other POSIX platforms lack /proc; group existence is conservative.
        try:
            os.killpg(self.pid, 0)
            return [self.pid]
        except ProcessLookupError:
            return []

    def stop(self, timeout=10):
        if not isinstance(timeout, (int, float)) or not 0 < timeout <= 60:
            raise ValueError("Owned cleanup timeout must be within0–60s")
        result = {"stopped": self._stopped, "rootStopped": self.returncode is not None,
                  "descendantsStopped": self._stopped, "forced": False, "errors": [],
                  "pid": self.pid,
                  "containment": "windows-job" if os.name == "nt" else "posix-session-group"}
        if self._stopped:
            return result
        deadline = time.monotonic() + timeout
        owned_handles = []
        try:
            result["rootStopped"] = self.poll() is not None
            if os.name == "nt":
                try:
                    _seal_job_creation(self._job)
                    owned_handles = _job_process_handles(self._job)
                except OSError as error:
                    # Still request native containment cleanup, but cannot claim verified stop.
                    result["errors"].append(str(error))
                    self._pending_handles.extend(getattr(error, "owned_handles", []))
                if _job_active(self._job):
                    result["forced"] = True
                    if not _kernel.TerminateJobObject(self._job, 1):
                        raise ctypes.WinError(ctypes.get_last_error())
                while _job_active(self._job) and time.monotonic() < deadline:
                    time.sleep(0.02)
                result["descendantsStopped"] = _job_active(self._job) == 0
                # Job accounting can reach zero slightly before process handles signal.
                # Keep exact owned handles, never reopened PIDs, through that completion.
                for handle in owned_handles:
                    if _winapi.WaitForSingleObject(handle, max(0, math.ceil((deadline - time.monotonic()) * 1000))) != _winapi.WAIT_OBJECT_0:
                        result["descendantsStopped"] = False
            else:
                members = self._posix_live_members()
                if members:
                    try:
                        os.killpg(self.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    grace = min(deadline, time.monotonic() + min(1, timeout / 2))
                    while self._posix_live_members() and time.monotonic() < grace:
                        time.sleep(0.02)
                    if self._posix_live_members():
                        result["forced"] = True
                        try:
                            os.killpg(self.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                while self._posix_live_members() and time.monotonic() < deadline:
                    time.sleep(0.02)
                result["descendantsStopped"] = not self._posix_live_members()
            try:
                self.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                result["errors"].append("Root process termination timed out")
            result["rootStopped"] = self.poll() is not None
            result["stopped"] = result["rootStopped"] and result["descendantsStopped"] and not result["errors"]
            if not result["stopped"]:
                result["errors"].append("Owned process group/job still has unconfirmed live members")
        except Exception as error:
            result["errors"].append(str(error))
            result["stopped"] = False
        finally:
            if os.name == "nt":
                remaining, failures = _close_handles(owned_handles)
                self._pending_handles.extend(remaining)
                if failures:
                    result["handleCloseErrors"] = [str(error) for error in failures]
                if remaining:
                    result["errors"].extend(str(error) for error in failures)
                    result["stopped"] = False
        if result["stopped"]:
            if os.name == "nt":
                try:
                    self._close_windows()
                except OSError as error:
                    result["errors"].append(str(error))
                    result["stopped"] = False
            self._stopped = result["stopped"]
        return result

    def _close_windows(self):
        # Closing the final noninherited job handle also kills contained children.
        handles = [getattr(self, name, None) for name in ("_job", "_handle")]
        handles = [handle for handle in handles if handle is not None]
        remaining, failures = _close_handles(handles + getattr(self, "_pending_handles", []))
        for name in ("_job", "_handle"):
            if getattr(self, name, None) not in remaining:
                setattr(self, name, None)
        self._pending_handles = [handle for handle in remaining if handle not in handles]
        if remaining:
            failures[0].unclosed_owned_handles = remaining
            raise failures[0]

    def __del__(self):
        if os.name == "nt":
            try:
                self._close_windows()
            except OSError:
                pass
