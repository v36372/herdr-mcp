# Herdr SDK MCP

- Run `npm run check` and `npm test` after changes.
- Use the installed `@herdr/sdk` public entrypoint. Never edit or import upstream source.
- Read `vendor/README.md` before a dependency update. Keep the SDK and Effect versions aligned.
- Keep stdout exclusive to MCP during normal operation.
- Keep writes opt-in and pane targets explicit. Never retry mutations automatically.
- Test only isolated local sockets. Never use a live Herdr socket or ambient session for verification.
- Preserve cancellation, runtime disposal, bounded output, and safe error messages.
