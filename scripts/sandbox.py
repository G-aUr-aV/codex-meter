#!/usr/bin/python3
"""Mount and syscall boundaries. Fail closed; never fall back to unsandboxed execution."""
import ctypes
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
STATE = Path('/var/lib/codex-meter')
NODE = '/opt/codex-meter/runtime/node'


def egress_filter():
    lib = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise RuntimeError('seccomp unavailable')
    fd = os.memfd_create('meter-network-policy', flags=0)
    try:
        for syscall in (b'connect', b'sendto', b'sendmsg', b'sendmmsg'):
            number = lib.seccomp_syscall_resolve_name(syscall)
            if number < 0 or lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError('seccomp rule failed')
        if lib.seccomp_export_bpf(ctx, fd) != 0:
            raise RuntimeError('seccomp export failed')
        os.lseek(fd, 0, os.SEEK_SET)
    finally:
        lib.seccomp_release(ctx)
    return fd


def command(role, probe=False):
    args = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session',
      '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
      '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/etc',
      '--ro-bind', str(ROOT), '/app', '--clearenv', '--setenv', 'PATH', '/usr/bin',
      '--setenv', 'HOME', '/tmp', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1', '--chdir', '/app']
    fd = egress_filter()
    args += ['--seccomp', str(fd)]
    if role == 'collector':
        args += ['--dir', '/input', '--ro-bind', '/home/ubuntu/.codex/sessions', '/input/sessions',
                 '--bind', str(STATE / 'collector'), '/state', '--bind', str(STATE / 'published'), '/published']
        archived = Path('/home/ubuntu/.codex/archived_sessions')
        if archived.exists():
            args += ['--ro-bind', str(archived), '/input/archived']
        else:
            args += ['--dir', '/input/archived']
        run = ['/usr/bin/python3', '/app/collector.py', '--source', '/input/sessions', '--source', '/input/archived',
               '--state', '/state', '--output', '/published/report.json', '--pricing', '/app/pricing.json']
    elif role == 'web':
        args += ['--share-net', '--ro-bind', str(STATE / 'published'), '/published',
                 '--bind', str(STATE / 'web'), '/state', '--ro-bind', '/etc/codex-meter', '/config',
                 '--dir', '/runtime', '--ro-bind', NODE, '/runtime/node']
        run = ['/runtime/node', '/app/server.mjs', '/config/app.json']
    else:
        os.close(fd)
        raise ValueError('unknown role')
    if probe:
        run = ['/usr/bin/python3', '/app/scripts/probe.py', role]
    return args + ['--'] + run, fd


if __name__ == '__main__':
    role = sys.argv[1]
    args, fd = command(role, '--probe' in sys.argv)
    try:
        raise SystemExit(subprocess.call(args, pass_fds=(fd,)))
    finally:
        os.close(fd)
