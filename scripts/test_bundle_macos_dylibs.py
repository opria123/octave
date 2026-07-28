#!/usr/bin/env python3
import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("bundler", Path(__file__).with_name("bundle_macos_dylibs.py"))
bundler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundler)


class FakeMachO:
    def __init__(self, metadata):
        self.metadata = metadata
        self.signed, self.verified = [], []

    def __call__(self, args, allow_failure=False):
        tool, *rest = args
        if tool == "otool":
            mode, path = rest
            item = self.metadata[Path(path).name]
            if mode == "-D":
                return f"{path}:\n" + (f"{item['id']}\n" if item.get("id") else "")
            if mode == "-L":
                deps = ([item["id"]] if item.get("id") else []) + item.get("deps", [])
                return f"{path}:\n" + "".join(f"\t{dep} (compatibility version 1.0.0)\n" for dep in deps)
            if mode == "-l":
                return "".join(f"cmd LC_RPATH\npath {entry} (offset 12)\n" for entry in item.get("rpaths", []))
        if tool == "install_name_tool":
            operation, old, *tail = rest
            if operation == "-id":
                self.metadata[Path(tail[0]).name]["id"] = old
            else:
                new, path = tail
                item = self.metadata[Path(path).name]
                item["deps"] = [new if dep == old else dep for dep in item.get("deps", [])]
            return ""
        if tool == "codesign":
            path = Path(rest[-1]).name
            if "--verify" in rest:
                if path not in self.signed:
                    raise bundler.BundleError(f"verified before signing: {path}")
                self.verified.append(path)
            else:
                self.signed.append(path)
            return ""
        raise AssertionError(args)


class BundleTests(unittest.TestCase):
    def touch(self, path, content=None):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content or path.name.encode())

    def test_recursive_graph_resolves_all_path_forms_and_signs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            stage, source, search, rpath = root / "stage", root / "source", root / "search", root / "rpath"
            files = {
                "app": stage / "app",
                "libabs.dylib": source / "libabs.dylib",
                "libloader.dylib": stage / "nested/libloader.dylib",
                "libexec.dylib": stage / "exec/libexec.dylib",
                "librpath.dylib": rpath / "librpath.dylib",
                "libtransitive.dylib": source / "libtransitive.dylib",
            }
            for path in files.values():
                self.touch(path)
            self.touch(search / "librpath.dylib", b"rpath-fallback-must-not-win")
            self.touch(search / "libtransitive.dylib", b"loader-fallback-must-not-win")
            metadata = {
                "app": {"deps": [str(files["libabs.dylib"]), "@loader_path/nested/libloader.dylib", "@executable_path/exec/libexec.dylib", "@rpath/librpath.dylib", "/usr/lib/libSystem.B.dylib"], "rpaths": [str(rpath)]},
                "libabs.dylib": {"id": str(files["libabs.dylib"]), "deps": ["@loader_path/libtransitive.dylib"]},
                "libloader.dylib": {"id": "old-loader", "deps": []},
                "libexec.dylib": {"id": "old-exec", "deps": []},
                "librpath.dylib": {"id": "old-rpath", "deps": []},
                "libtransitive.dylib": {"id": "old-transitive", "deps": []},
            }
            fake = FakeMachO(metadata)
            output = io.StringIO()
            with patch.object(bundler, "command", fake), contextlib.redirect_stdout(output):
                bundler.close_graph(files["app"], [search])
            self.assertEqual(output.getvalue(), "bundled 5 libraries; signed 6 Mach-O files\n")
            self.assertEqual(sorted(fake.signed), sorted(fake.verified))
            self.assertEqual((stage / "librpath.dylib").read_bytes(), files["librpath.dylib"].read_bytes())
            self.assertEqual((stage / "libtransitive.dylib").read_bytes(), files["libtransitive.dylib"].read_bytes())
            for name in files:
                if name != "app":
                    self.assertTrue((stage / name).is_file())
                    self.assertEqual(metadata[name]["id"], f"@loader_path/{name}")
            self.assertTrue(all(dep.startswith("@loader_path/") or dep.startswith("/usr/lib/") for dep in metadata["app"]["deps"]))

    def test_missing_ambiguous_search_and_basename_collision_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            stage, one, two = root / "stage", root / "one", root / "two"
            app = stage / "app"
            self.touch(app)
            with patch.object(bundler, "command", FakeMachO({"app": {"deps": ["@rpath/libmissing.dylib"]}})):
                with self.assertRaisesRegex(bundler.BundleError, "missing"):
                    bundler.close_graph(app, [])
            for directory in (one, two):
                self.touch(directory / "libsame.dylib")
            fake = FakeMachO({"app": {"deps": ["@rpath/libsame.dylib"]}})
            with patch.object(bundler, "command", fake):
                with self.assertRaisesRegex(bundler.BundleError, "ambiguous"):
                    bundler.close_graph(app, [one, two])
            left, right = root / "left/libdup.dylib", root / "right/libdup.dylib"
            self.touch(left)
            self.touch(right)
            fake = FakeMachO({"app": {"deps": [str(left), str(right)]}, "libdup.dylib": {"id": "old", "deps": []}})
            with patch.object(bundler, "command", fake):
                with self.assertRaisesRegex(bundler.BundleError, "basename collision"):
                    bundler.close_graph(app, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
