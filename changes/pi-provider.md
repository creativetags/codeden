---
section: added
---

- **Pi as a provider.** CodeDen can run sessions on the Pi coding agent through its RPC mode, using the user's own Pi login, settings and extensions. Pi has no permission system of its own, so every tool call is decided by CodeDen's permission level: approved on the spot, refused with the reason for the model, or shown as an approval card, with read-only sessions enforced the same way. CodeDen's own MCP tools are registered with the session, and Pi's model list, thinking levels, steering, Stop and "Compact now" work as they do on the other providers. Sessions keep their files in CodeDen's home, so `pi --resume` stays the user's own.
