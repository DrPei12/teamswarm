# npm runtime

`npm-11.21.1-teamswarm.2.tgz` contains npm 11.21.1 with its bundled
`ip-address 10.7.2` and `undici 6.29.0` replaced by the unmodified upstream
10.7.4 and 6.29.1 packages. These address
[IPv6 validation](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5),
[EventSource memory growth](https://github.com/advisories/GHSA-4qv8-2p9j-2685) and
[content-encoding errors](https://github.com/advisories/GHSA-xjj6-f33q-929c).
The other changes are the npm version in `package.json` and
`TEAMSWARM-NOTICE.md`. All remaining upstream file bytes and modes are retained.

`npm-runtime.json` records the official registry URLs and SHA-512 integrity
values. Reproduce the archive using Python 3 and the standard library:

```sh
python -B scripts/rebuild-npm-runtime.py
python -B scripts/rebuild-npm-runtime.py --check
```

The script verifies all downloads, rejects unexpected archive entries, replaces
only the affected packages and writes a deterministic tar archive. The check
compares the committed archive with those pinned inputs without modifying it.
CI checks this provenance before installing dependencies, then runs the normal
dependency audit and executable runtime regressions. Normal `npm ci` installs the
committed archive directly, including when lifecycle scripts are disabled.

The npm source and modifications remain available under Artistic-2.0, with
redistribution under that same license permitted. Dependencies retain their own
licenses. Their upstream license files and notices are included in the archive
and desktop package inventory.

When an official npm release includes the fix, replace the local dependency with
that release, update `config/desktop-runtime.json` and the lockfile, and repeat the
runtime, audit and desktop package checks.

## 中文

该归档基于 npm 11.21.1，将内置的 `ip-address 10.7.2` 和 `undici 6.29.0`
分别替换为官方 10.7.4 和 6.29.1，
更新 npm 版本标识并加入变更说明。其余上游文件的字节与权限保持一致。
来源和 SHA-512 固定在 `npm-runtime.json`，使用上方命令可生成或核对归档。
普通 `npm ci` 直接安装归档，关闭生命周期脚本时同样包含修复。
npm 及变更沿用 Artistic-2.0，依赖沿用各自许可证，原始许可文件随包保留。
