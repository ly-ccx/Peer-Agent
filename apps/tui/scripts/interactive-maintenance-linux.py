#!/usr/bin/python3 -I
"""Launch the installed Peer maintenance CLI in a managed Linux rescue boot."""

import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import stat
import subprocess
import sys

CONFIG = Path("/etc/peer-agent/interactive-maintenance.json")
GATE = Path("/run/peer-agent/interactive-maintenance.lock")
PEER = Path("/usr/local/libexec/peer-agent/peer")
BOOT = Path("/proc/sys/kernel/random/boot_id")
SYSTEM_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
FIELDS = {"dataHome", "dataDevice", "dataInode", "uid", "gid", "normalBootId", "peerSha256"}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def checked_ancestors(path):
    require(path.is_absolute() and path == path.resolve(strict=True), "path is not canonical")
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "ancestor is not protected by root")


def root_file(fd):
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and not info.st_mode & 0o022, "file is not protected by root")
    return info


def mount_path(value):
    return Path(re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value))


def check_mounts(root, device):
    expected = f"{os.major(device)}:{os.minor(device)}"
    mounts = [(row[2], mount_path(row[3]), mount_path(row[4]), row[row.index("-") + 1])
              for row in (line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines())]
    ancestors = [entry for entry in mounts if root.is_relative_to(entry[2])]
    require(ancestors, "managed volume is not visible")
    base = max(ancestors, key=lambda entry: len(entry[2].parts))
    require(base[0] == expected and base[1] == Path("/") and base[3] == "ext4",
            "managed data root needs an unaliased ext4 volume")
    managed = base[1] / root.relative_to(base[2])
    for entry in mounts:
        if entry == base:
            continue
        dev, source, mountpoint, _ = entry
        require(not mountpoint.is_relative_to(root), "managed tree contains a mount")
        require(dev != expected or not (managed.is_relative_to(source) or source.is_relative_to(managed)),
                "managed tree is visible through another mount")


def check_tree(root, device):
    # Reject aliases, linked files, special files and nested volumes in the authority tree.
    pending = [root]
    seen = 0
    while pending:
        with os.scandir(pending.pop()) as children:
            for child in children:
                seen += 1
                require(seen <= 100_000, "managed tree exceeds inspection limit")
                info = child.stat(follow_symlinks=False)
                require(info.st_dev == device, "managed tree crosses a volume")
                if stat.S_ISDIR(info.st_mode):
                    pending.append(child.path)
                else:
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                            "managed tree contains an alias or special file")


def check_boot(normal_boot):
    boot = BOOT.read_text().strip()
    require(boot != normal_boot, "cold boot after settlement is required")
    require("systemd.unit=rescue.target" in Path("/proc/cmdline").read_text().split(),
            "rescue boot is required")
    require(Path("/proc/1/comm").read_text().strip() == "systemd", "systemd host is required")
    for namespace in ("pid", "mnt", "user"):
        require(os.readlink(f"/proc/self/ns/{namespace}") == os.readlink(f"/proc/1/ns/{namespace}"),
                "host namespaces are required")
    container = subprocess.run(["/usr/bin/systemd-detect-virt", "--quiet", "--container"], check=False, env=SYSTEM_ENV)
    require(container.returncode == 1, "a non-container Linux host is required")
    state = subprocess.run(
        ["/usr/bin/systemctl", "show", "-p", "ActiveState", "--value", "multi-user.target", "graphical.target"],
        check=True, capture_output=True, text=True, env=SYSTEM_ENV,
    )
    require(state.stdout.split() == ["inactive", "inactive"], "normal boot targets are active")


def check_service_identity(uid):
    for proc in Path("/proc").iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            status = (proc / "status").read_text()
        except FileNotFoundError:
            continue
        ids = next((row.split()[1:] for row in status.splitlines() if row.startswith("Uid:")), None)
        require(ids is not None and str(uid) not in ids, "managed identity has a running process")


def main(args):
    require(os.getuid() == os.geteuid() == 0, "administrator launch is required")
    require(not args, "send one request on stdin")
    os.umask(0o077)
    checked_ancestors(CONFIG)
    config_fd = os.open(CONFIG, os.O_RDONLY | os.O_NOFOLLOW)
    info = root_file(config_fd)
    require(stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= 4096, "invalid enrollment file")
    config = json.loads(os.pread(config_fd, 4096, 0))
    require(type(config) is dict and config.keys() == FIELDS, "invalid enrollment")
    uid, gid = config["uid"], config["gid"]
    require(type(uid) is int and type(gid) is int and 0 < uid < 2**31 and 0 < gid < 2**31,
            "a dedicated non-root UID and GID are required")
    require(isinstance(config["normalBootId"], str) and len(config["normalBootId"]) == 36,
            "invalid normal boot identity")
    check_boot(config["normalBootId"])

    GATE.parent.mkdir(mode=0o700, exist_ok=True)
    require(stat.S_IMODE(GATE.parent.lstat().st_mode) == 0o700, "maintenance gate is not private")
    require(GATE.parent.lstat().st_uid == 0, "maintenance gate is not owned by root")
    # The private directory is stable. Keep the same inode for every maintenance invocation.
    gate_fd = os.open(GATE, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    checked_ancestors(GATE)
    require(stat.S_IMODE(root_file(gate_fd).st_mode) == 0o600, "invalid maintenance gate")
    fcntl.flock(gate_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    check_service_identity(uid)

    data = Path(config["dataHome"])
    checked_ancestors(data)
    root = data.lstat()
    require(stat.S_ISDIR(root.st_mode) and stat.S_IMODE(root.st_mode) == 0o700 and root.st_uid == uid
            and str(root.st_dev) == config["dataDevice"] and str(root.st_ino) == config["dataInode"],
            "managed data root identity or permissions changed")
    check_mounts(data, root.st_dev)
    check_tree(data, root.st_dev)

    checked_ancestors(PEER)
    with PEER.open("rb") as binary:
        root_file(binary.fileno())
        require(hashlib.file_digest(binary, "sha256").hexdigest() == config["peerSha256"],
                "installed Peer build does not match enrollment")

    for fd in (gate_fd, config_fd):
        os.set_inheritable(fd, True)
    os.chdir("/")
    setpriv = "/usr/bin/setpriv"
    os.execve(setpriv, [
        setpriv, "--reuid", str(uid), "--regid", str(gid), "--clear-groups",
        "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs",
        str(PEER), "__interactive-maintenance", str(gate_fd), str(config_fd),
    ], {**SYSTEM_ENV, "HOME": str(data)})


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
        print(f"peer interactive maintenance: {error}", file=sys.stderr)
        sys.exit(3)
