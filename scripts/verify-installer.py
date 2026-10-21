"""Verify the actual NSIS-embedded ZIP against the complete packaged application."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile
import zipfile


def digest(stream):
    value = hashlib.sha256()
    while block := stream.read(1024 * 1024):
        value.update(block)
    return value.hexdigest()


def verify(installer, unpacked, root, scratch):
    tools = scratch / "tools"
    tools.mkdir()
    vendor = root / "node_modules/electron-winstaller/vendor"
    shutil.copyfile(vendor / "7z-x64.exe", tools / "7z.exe")
    shutil.copyfile(vendor / "7z-x64.dll", tools / "7z.dll")
    extracted = scratch / "extracted"
    process = subprocess.run(
        [str(tools / "7z.exe"), "x", "-y", "-o" + str(extracted),
         str(installer), r"$PLUGINSDIR\app-64.zip"],
        capture_output=True, timeout=180, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    (scratch / "extract.log").write_bytes(process.stdout + process.stderr)
    if process.returncode:
        raise ValueError("NSIS payload extraction failed; see extract.log")
    archive = extracted / "$PLUGINSDIR/app-64.zip"
    hashes = {}
    with zipfile.ZipFile(archive) as contents:
        build = json.loads(contents.read("resources/product/build-identity.json"))
        current = json.loads((root / ".codex-local/build-identity.json").read_text("utf-8"))
        if build != current:
            raise ValueError("Installer embeds a different candidate build")
        inventory = json.loads(contents.read("resources/product/package-inventory.json"))
        for entry in contents.infolist():
            if entry.is_dir():
                continue
            relative = entry.filename.replace("\\", "/")
            pure = pathlib.PurePosixPath(relative)
            if (pure.is_absolute() or pathlib.PureWindowsPath(relative).is_absolute()
                    or ".." in pure.parts or relative in hashes
                    or (entry.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError("Unsafe or duplicate payload path: " + relative)
            with contents.open(entry) as source:
                actual = digest(source)
            with (unpacked / relative).open("rb") as source:
                if digest(source) != actual:
                    raise ValueError("Installer payload differs: " + relative)
            hashes[relative] = actual
        observed = {file.relative_to(unpacked).as_posix()
                    for file in unpacked.rglob("*") if file.is_file()}
        if observed != set(hashes):
            raise ValueError("Installer and unpacked file sets differ")
        for relative, expected in inventory["files"].items():
            if hashes.get("resources/product/" + relative) != expected:
                raise ValueError("Product inventory differs: " + relative)
    with installer.open("rb") as source:
        installer_sha = digest(source)
    with archive.open("rb") as source:
        archive_sha = digest(source)
    return {
        "passed": True, "scope": "actual NSIS-embedded payload and complete desktop file set",
        "commit": build["commit"], "sourceSha256": build["sourceSha256"],
        "installer": installer.name, "installerSha256": installer_sha,
        "installerBytes": installer.stat().st_size, "payloadSha256": archive_sha,
        "payloadBytes": archive.stat().st_size, "fileCount": len(hashes),
        "productFiles": len(inventory["files"]), "files": hashes,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", required=True, type=pathlib.Path)
    parser.add_argument("--unpacked", required=True, type=pathlib.Path)
    parser.add_argument("--evidence", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if args.evidence.exists():
        parser.error("Use a new evidence file")
    root = pathlib.Path(__file__).resolve().parent.parent
    scratch_parent = root / ".codex-local/installer-verification"
    scratch_parent.mkdir(parents=True, exist_ok=True)
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="payload-", dir=scratch_parent)).resolve()
    if not scratch.is_relative_to(scratch_parent.resolve()):
        raise ValueError("Unexpected verification directory")
    report = {"passed": False}
    try:
        report.update(verify(args.installer.resolve(), args.unpacked.resolve(), root, scratch))
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if report["passed"]:
        shutil.rmtree(scratch)
    print(json.dumps({key: value for key, value in report.items() if key != "files"}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
