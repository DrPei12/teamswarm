"""Reproduce the pinned npm bundle with pinned upstream dependency security fixes."""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "vendor/npm-runtime.json"


def fetch(spec):
    with urllib.request.urlopen(spec["url"], timeout=60) as response:
        data = response.read()
    actual = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != spec["integrity"]:
        raise ValueError("Upstream archive integrity mismatch: " + spec["url"])
    return data


def entries(data):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or name.parts[0] != "package":
                raise ValueError("Unexpected archive path: " + member.name)
            if member.isdir():
                continue
            if not member.isfile() or member.name in result:
                raise ValueError("Unexpected archive entry: " + member.name)
            result[member.name] = (archive.extractfile(member).read(), member.mode)
    return result


def rebuild(config):
    original = entries(fetch(config["npm"]))
    package = json.loads(original["package/package.json"][0])
    if package["version"] != config["npm"]["version"]:
        raise ValueError("Unexpected upstream npm bundle")
    replacements = [("ipAddress", "ip-address", "10.7.2"), ("undici", "undici", "6.29.0")]
    files = dict(original)
    prefixes = []
    for key, name, old_version in replacements:
        prefix = "package/node_modules/" + name + "/"
        prefixes.append(prefix)
        replacement = entries(fetch(config[key]))
        old = json.loads(original[prefix + "package.json"][0])
        new = json.loads(replacement["package/package.json"][0])
        if old["name"] != name or old["version"] != old_version:
            raise ValueError("Unexpected bundled package: " + name)
        if new["name"] != name or new["version"] != config[key]["version"]:
            raise ValueError("Unexpected replacement package: " + name)
        files = {path: value for path, value in files.items() if not path.startswith(prefix)}
        for path, value in replacement.items():
            files[prefix + path.removeprefix("package/")] = value
    package["version"] = config["version"]
    files["package/package.json"] = ((json.dumps(package, indent=2) + "\n").encode(), 0o644)
    files["package/TEAMSWARM-NOTICE.md"] = (
        ("# npm runtime distributed with TeamSwarm\n\n"
         f"Based on npm {config['npm']['version']}, with unmodified upstream "
         f"ip-address {config['ipAddress']['version']} and undici {config['undici']['version']}. "
         "These replace bundled ip-address 10.7.2 and undici 6.29.0.\n\n"
         "npm source and these modifications are redistributable under Artistic-2.0. "
         "Bundled dependencies retain their licenses. Upstream notices are preserved.\n\n"
         "Sources and reproduction: https://github.com/DrPei12/teamswarm/tree/main/vendor\n"
         + "".join(f"{key}: {config[key]['url']}\n" for key in ["npm", "ipAddress", "undici"])
         ).encode(), 0o644)
    for name, value in original.items():
        if name != "package/package.json" and not any(name.startswith(prefix) for prefix in prefixes):
            assert files[name] == value
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.GNU_FORMAT) as archive:
            for name in sorted(files):
                data, mode = files[name]
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = len(data), mode, 0
                archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify the committed archive without writing")
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    output = ROOT / "vendor" / f"npm-{config['version']}.tgz"
    data = rebuild(config)
    if args.check:
        # Compare uncompressed archives so zlib versions cannot change this check.
        if gzip.decompress(output.read_bytes()) != gzip.decompress(data):
            raise ValueError("Committed npm archive differs from pinned upstream inputs")
    else:
        output.write_bytes(data)
    print(json.dumps({"verified": True, "version": config["version"],
                      "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                      "bytes": output.stat().st_size}))


if __name__ == "__main__":
    main()
