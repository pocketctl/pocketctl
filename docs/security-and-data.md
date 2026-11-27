# Security, data processing, and session retention

[Back to README](../README.md)

The retention details below describe an experimental implementation and local acceptance scope, not activation on the hosted service. The current Privacy Policy governs the hosted service.

## Security and data boundary

PocketCtl keeps repositories and agent processes on the development host, but
that does **not** mean session content stays local.

Eligible personal sessions archive after more than 7 days of verified inactivity.
Archived history moves to private cold storage. Cloud session data is permanently
deleted after more than 3 days from actual archiving, subject to protection checks. Business activity
restores an inactivity archive; reading a session does not renew its lifetime.
Lifecycle and system-notification configuration defaults are enabled, but new
automatic lifecycle actions remain blocked in production pending the storage,
backup, policy, client-release, and capacity gates. This source release does not
activate a new retention policy on the hosted service.

- Production transport uses HTTPS/WSS.
- Read-only share links allow anonymous access to shared content, expire after 15 minutes, and can be revoked. Review content before sharing.
- Session and tool content is **not end-to-end encrypted**. The configured Relay
  can read and persist normalized content required for routing, replay,
  notifications, and account features.
- If `MIMO_API_KEY` is configured on the Relay, the text needed to generate a
  session title is sent to Xiaomi MiMo first with thinking disabled. A MiMo
  timeout falls back to DeepSeek when `DEEPSEEK_API_KEY` is configured; without
  either key, title generation is skipped.
- If Memory is enabled, model-assisted knowledge extraction sends the relevant
  repository text to the configured server-side provider. Pre-turn context
  packs travel through the authenticated Relay like other session content;
  the daemon never persists or logs them.
- If Team collaboration is enabled, explicit shared events and frozen Context
  are stored by Relay and delivered to selected members' Agents. Native private
  session logs are not shared automatically; Team Memory accepts only exact,
  authorized published references.
- Managed Codex/OpenCode endpoints and local runtime credentials remain on the
  development host; clients communicate through the authenticated Relay.

Review the current [Privacy Policy](https://www.pocketctl.me/privacy.html) before
using the hosted service or connecting sensitive repositories.
