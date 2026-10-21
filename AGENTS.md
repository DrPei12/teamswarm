# Working on TeamSwarm

Use Node.js 24 and install the lockfile with `npm ci`. Read the relevant current guide in `docs/en/` before changing its behavior.

Run `npm run check` and `npm run build` for runtime changes. Use `npm run test:smoke` for local service startup/restart checks. Desktop changes require packaging and checking the resulting artifact on its target operating system.

Keep native harness sessions and tools independent. Preserve actual execution status, permissions, version identity and recovery. Never replace unknown completion with an assumed success, or change a production path to return fixture results.

Keep private credentials, raw user sessions, experiment databases and generated packages out of source control. Public examples use synthetic data. Retain third-party notices and keep English/Chinese user instructions aligned.

Use TeamSwarm and the actual version in product text. Describe user actions and results directly. Preserve other contributors' work and keep changes focused on the requested outcome.
