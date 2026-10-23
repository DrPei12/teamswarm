# Harnesses and models

[First project](getting-started.md) · [Troubleshooting](troubleshooting.md) · [中文](../zh-CN/harnesses.md)

A harness runs the agent loop and its tools. A model provider supplies the model API. An execution resource binds a harness to a model, connection, permission level and optional reasoning settings. Multiple harnesses can use the same provider through their supported protocols.

| Harness | Installation | Native session continuation |
|---|---|---|
| Codex | Bundled in desktop packages; installed CLI also supported | Supported when configuration and context remain compatible |
| Claude Code | Separate device installation | Supported |
| Grok | Separate device installation | Supported |
| Pi | Separate device installation | Supported |
| DeepSeek Harness | Separate device installation | A new native session continues from saved TeamSwarm work |
| OpenCode | Separate device installation | Supported |

Platform-specific verification is listed in [Platform support](platforms.md). Compatibility also depends on the installed harness version and the chosen model/protocol combination. Pinned integration versions are in [config/harnesses.json](../../config/harnesses.json).

## Existing account

Select a harness in the team's execution settings, then use its account controls. The official harness owns its login flow and account session. TeamSwarm checks that installation and account access are available. A Codex account is used through Codex's supported account flow; API connections are configured separately.

## Official API connection

1. Install a harness that supports the provider's protocol. The application can manage supported device installations when a usable device Node/npm installation is present.
2. In execution settings, open the model/connection configuration. Enter the provider's official base URL and a model name offered by that provider.
3. Select the protocol supported by both the provider and harness, such as OpenAI-compatible chat completions or Anthropic Messages.
4. Save the API key using the desktop keyring, or enter an environment-variable reference in advanced settings.
5. Save the configuration and check its availability. Run a small task to verify actual tool use.

For example, a DeepSeek connection uses `https://api.deepseek.com` and a model available to your account. Choose its supported chat-completions protocol and a compatible harness such as Pi or OpenCode. Model names and availability are supplied by the provider; use the current model list in the configuration screen.

For environment credentials, set a variable such as `DEEPSEEK_API_KEY` in the environment that launches the service. Enter only that variable name in the credential-reference field. `TEAM_CREDENTIAL_FILES` also accepts a JSON map from environment names to absolute one-line secret files, for local service startup.

## Install tools from source

Build the service first, then install selected harnesses through the device installer:

```sh
npm run build
npm run harness:install -- pi opencode
npm run harness:check -- pi opencode
```

The installer checks the device npm prefix and refuses a prefix inside a project or TeamSwarm's application directory. Installed tools remain available independently of TeamSwarm.

Pass harness IDs to check only those installations. Omit IDs to inspect all registered harnesses. The command prints each result, including individual errors, and exits with status 1 if a selected harness is unavailable or its inspection fails.

## Allocation and permissions

In **Resources and allocation**, create named resources and assign member defaults or work-specific resources. A work-specific selection takes precedence over the member default. Configuration is captured for each attempt; changing a resource affects subsequent work.

Use read-only access for questions and inspection, and workspace-write access for changes. Switching harness, model, protocol or account can require a new native session. Project responsibilities, conversations and deliverable versions remain in TeamSwarm.

Resource export/import transfers configuration and credential references. Configure the referenced secrets separately on the destination device.

For Pi and OpenCode, the optional `maxOutputTokens` field in resource API configuration or an imported resource package sets the completion ceiling for each model response, including reasoning tokens. Omit it or set it to null to retain the 8192-token default. Set a value supported by your provider; this setting does not change provider limits or pricing. A response that ends at the length limit remains failed and is not automatically retried. Other harnesses reject this override rather than silently ignoring it.

Resource API/import configuration also accepts `contextWindowTokens` for Pi/OpenCode (default 131072). This is local model metadata, not a request to increase the provider’s capacity. Set it from the actual model/provider limits; input plus reasoning and output must still fit the provider’s window. Pi chat-completions resources can set `effort` to `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` when the provider supports that value. The selected value is forwarded as `reasoning_effort`; `max` is explicitly mapped so Pi does not silently clamp it to a lower level. Omitted effort preserves the old behavior and does not establish that the provider disables reasoning. Other Pi protocols and OpenCode reject this effort override. Raising a context window does not fix an output-length stop.
