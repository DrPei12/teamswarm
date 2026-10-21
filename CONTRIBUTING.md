# Contributing to TeamSwarm

Thank you for helping improve TeamSwarm. Focused bug reports, reproducible examples, documentation fixes and code contributions are welcome.

## Work locally

Use Node.js 24. Run `npm ci`, then `npm run check` and `npm run build`. Start the browser application with `npm start`, or use `npm run dev` while editing. Desktop packaging instructions are in [Development](docs/en/development.md).

Use a new test workspace and a small example when changing runtime behavior. Ordinary tests use deterministic harness fixtures and do not call paid providers. Live provider checks are separate and require your own account or API key.

## Submit a change

1. Describe the user-visible problem or capability in an issue or pull request.
2. Make a focused change with tests appropriate to its behavior. Preserve existing user data and work.
3. Run the checks relevant to the change. For interface changes, exercise the screen at desktop and narrow widths and in both languages.
4. Update the current documentation when installation, configuration, storage or supported behavior changes.
5. In the pull request, describe the resulting behavior, validation and any outstanding platform-specific work.

Keep native harness sessions independent. A stopped process, completed command, submitted artifact and accepted work are separate states. Report the state actually observed, and preserve recovery when termination is uncertain.

Do not include API keys, login sessions, personal project databases or private transcripts in issues, fixtures or screenshots. See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

By submitting a contribution for inclusion, you agree that it is provided under the project's Apache-2.0 license. Retain existing third-party notices and document the origin and license of newly added code or assets.

## 中文

欢迎提交可复现的问题、文档修改和聚焦的代码贡献。使用 Node.js 24，先运行 `npm ci`、`npm run check` 与 `npm run build`。普通测试不会调用付费模型，真实模型检查需要单独配置自己的账号。

提交时说明用户问题、变更后的行为和实际完成的验证；界面变化检查中英文及不同窗口宽度，数据与执行变化保留恢复路径。同步更新相关文档，并保留第三方许可。提交供项目收录的贡献按 Apache-2.0 提供。
