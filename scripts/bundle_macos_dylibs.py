#!/usr/bin/env python3
"""Close, relocate, and ad-hoc-sign a staged macOS Mach-O dependency graph."""

import argparse
import re
import shutil
import subprocess
from collections import deque
from pathlib import Path

SYSTEM_PREFIXES = ("/System/Library/", "/usr/lib/")


class BundleError(RuntimeError):
    pass


def command(args, allow_failure=False):
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode and not allow_failure:
        detail = (result.stderr or result.stdout).strip()
        raise BundleError(f"{' '.join(args)} failed ({result.returncode}): {detail}")
    return result.stdout


def dylib_id(path):
    lines = command(["otool", "-D", str(path)], allow_failure=True).splitlines()[1:]
    return next((line.strip() for line in lines if line.strip()), None)


def dependencies(path):
    own_id = dylib_id(path)
    result = []
    for line in command(["otool", "-L", str(path)]).splitlines()[1:]:
        dependency = line.strip().split(" (", 1)[0]
        if dependency and dependency != own_id:
            result.append(dependency)
    return result


def rpaths(path):
    lines = command(["otool", "-l", str(path)]).splitlines()
    result = []
    for index, line in enumerate(lines):
        if line.strip() != "cmd LC_RPATH":
            continue
        for candidate in lines[index + 1:index + 5]:
            match = re.match(r"\s*path (.+) \(offset \d+\)$", candidate)
            if match:
                result.append(match.group(1))
                break
    return result


def expand(value, loader, executable):
    for token, base in (("@loader_path", loader.parent), ("@executable_path", executable.parent)):
        if value == token:
            return base.resolve()
        if value.startswith(token + "/"):
            return (base / value[len(token) + 1:]).resolve()
    return Path(value).resolve() if value.startswith("/") else None


def unique_existing(paths):
    return sorted({path.resolve() for path in paths if path.is_file()}, key=str)


def resolve_dependency(dependency, loader, executable, loader_rpaths, searches):
    if dependency.startswith(SYSTEM_PREFIXES):
        return None
    direct = []
    if dependency.startswith("@rpath/"):
        suffix = dependency[len("@rpath/"):]
        for entry in loader_rpaths:
            base = expand(entry, loader, executable)
            if base is not None:
                direct.append(base / suffix)
    else:
        resolved = expand(dependency, loader, executable)
        direct.append(resolved if resolved is not None else loader.parent / dependency)
    candidates = unique_existing(direct)
    if not candidates:
        candidates = unique_existing(directory / Path(dependency).name for directory in searches)
    if len(candidates) != 1:
        state = "missing" if not candidates else "ambiguous: " + ", ".join(map(str, candidates))
        raise BundleError(f"cannot resolve {dependency} from {loader}: {state}")
    return candidates[0]


def close_graph(executable, searches):
    executable = executable.resolve()
    stage = executable.parent
    if not executable.is_file():
        raise BundleError(f"staged executable does not exist: {executable}")
    for directory in searches:
        if not directory.is_dir():
            raise BundleError(f"search directory does not exist: {directory}")

    queue = deque([(executable, executable)])
    seen, changed, bundled = set(), set(), set()
    owners = {executable.name: executable}
    while queue:
        origin, current = queue.popleft()
        current = current.resolve()
        if current in seen:
            continue
        seen.add(current)
        current_rpaths = rpaths(origin)
        for dependency in dependencies(origin):
            source = resolve_dependency(dependency, origin, executable, current_rpaths, searches)
            if source is None:
                continue
            name = Path(dependency).name
            if not name or "/" in name:
                raise BundleError(f"invalid dependency basename: {dependency}")
            destination = stage / name
            prior = owners.get(name)
            source_real = source.resolve()
            destination_real = destination.resolve() if destination.exists() else None
            if prior is not None and source_real not in (prior, destination_real):
                raise BundleError(f"basename collision for {name}: {prior} vs {source_real}")
            if prior is None:
                if destination.exists() and source_real != destination_real:
                    raise BundleError(f"destination collision for {name}: {destination}")
                owners[name] = source_real
                if source_real != destination_real:
                    shutil.copy2(source_real, destination)
                command(["install_name_tool", "-id", f"@loader_path/{name}", str(destination)])
                changed.add(destination.resolve())
                bundled.add(destination.resolve())
                queue.append((source_real, destination))
            relocated = f"@loader_path/{name}"
            if dependency != relocated:
                command(["install_name_tool", "-change", dependency, relocated, str(current)])
                changed.add(current)

    for path in sorted(seen, key=str):
        if path in bundled and dylib_id(path) != f"@loader_path/{path.name}":
            raise BundleError(f"dylib ID was not normalized: {path}")
        for dependency in dependencies(path):
            if dependency.startswith(SYSTEM_PREFIXES):
                continue
            prefix = "@loader_path/"
            name = dependency[len(prefix):] if dependency.startswith(prefix) else ""
            if not name or "/" in name or not (stage / name).is_file():
                raise BundleError(f"non-closed dependency in {path}: {dependency}")

    for path in sorted(changed, key=str):
        command(["codesign", "--force", "--sign", "-", "--timestamp=none", str(path)])
    for path in sorted(changed, key=str):
        command(["codesign", "--verify", "--strict", str(path)])
    print(f"bundled {len(bundled)} libraries; signed {len(changed)} Mach-O files")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    parser.add_argument("--search", action="append", default=[], type=Path)
    args = parser.parse_args()
    try:
        close_graph(args.executable, [path.resolve() for path in args.search])
    except (BundleError, OSError) as error:
        parser.exit(1, f"error: {error}\n")


if __name__ == "__main__":
    main()
