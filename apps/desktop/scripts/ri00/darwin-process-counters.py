"""Read-only sidecar: libproc counters, no task port, injection, priority or power changes."""
import ctypes
import json
import sys
import time

if sys.platform != "darwin":
    raise RuntimeError("darwin_required")

FIELDS = """ri_user_time ri_system_time ri_pkg_idle_wkups ri_interrupt_wkups ri_pageins
ri_wired_size ri_resident_size ri_phys_footprint ri_proc_start_abstime ri_proc_exit_abstime
ri_child_user_time ri_child_system_time ri_child_pkg_idle_wkups ri_child_interrupt_wkups
ri_child_pageins ri_child_elapsed_abstime ri_diskio_bytesread ri_diskio_byteswritten
ri_cpu_time_qos_default ri_cpu_time_qos_maintenance ri_cpu_time_qos_background
ri_cpu_time_qos_utility ri_cpu_time_qos_legacy ri_cpu_time_qos_user_initiated
ri_cpu_time_qos_user_interactive ri_billed_system_time ri_serviced_system_time
ri_logical_writes ri_lifetime_max_phys_footprint ri_instructions ri_cycles
ri_billed_energy ri_serviced_energy ri_interval_max_phys_footprint ri_runnable_time""".split()

class Usage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in FIELDS]

class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]

class Thread(ctypes.Structure):
    _fields_ = [("user", ctypes.c_uint64), ("system", ctypes.c_uint64)] + [
        (name, ctypes.c_int32) for name in ["cpu", "policy", "state", "flags", "sleep", "currentPriority", "priority", "maxPriority"]
    ] + [("name", ctypes.c_char * 64)]

lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
lib.proc_pid_rusage.restype = ctypes.c_int
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
lib.proc_pidinfo.restype = ctypes.c_int
system = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
timebase = Timebase()
if system.mach_timebase_info(ctypes.byref(timebase)) != 0 or ctypes.sizeof(Usage) != 296 or ctypes.sizeof(Thread) != 112:
    raise RuntimeError("counter_abi_unverified")

def read(pid):
    if not isinstance(pid, int) or pid < 1:
        raise ValueError("invalid_pid")
    usage = Usage()
    if lib.proc_pid_rusage(pid, 4, ctypes.byref(usage)) != 0:
        raise OSError(ctypes.get_errno(), "rusage_read_failed")
    ids = (ctypes.c_uint64 * 1024)()
    size = lib.proc_pidinfo(pid, 6, 0, ctypes.byref(ids), ctypes.sizeof(ids))
    if size <= 0 or size >= ctypes.sizeof(ids) or size % 8:
        raise OSError(ctypes.get_errno(), "thread_list_unverified")
    threads = []
    for tid in ids[:size // 8]:
        info = Thread()
        if lib.proc_pidinfo(pid, 5, tid, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
            continue  # A thread can exit; no guessed counters are inserted.
        name = info.name.decode("utf8", "replace")
        category = next((label for prefix, label in [("ThreadPool", "chromium-pool"), ("V8", "v8-worker"),
            ("Chrome_IOThread", "chromium-io"), ("CrBrowserMain", "browser-main")] if name.startswith(prefix)), "unclassified")
        threads.append({"id": str(tid), "user": str(info.user), "system": str(info.system), "category": category,
                        "currentPriority": info.currentPriority, "priority": info.priority, "policy": info.policy})
    return {"atNs": str(time.monotonic_ns()), "values": {name: str(getattr(usage, name)) for name in FIELDS}, "threads": threads}

print(json.dumps({"ready": True, "abiBytes": ctypes.sizeof(Usage), "timebase": {"numer": timebase.numer, "denom": timebase.denom},
                  "limitThreads": 1024, "processTimeUnits": "mach-absolute-ticks", "threadTimeUnits": "raw-unverified"}), flush=True)
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        result = {"id": request["id"], "ok": True, "point": read(request["pid"])}
    except Exception as error:
        result = {"id": request.get("id"), "ok": False, "name": type(error).__name__, "errno": getattr(error, "errno", None)}
    print(json.dumps(result), flush=True)
