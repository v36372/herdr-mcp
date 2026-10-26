# Herdr scoped connections

Create these two Executor scoped connections for the `Herdr SDK` app:

| Profile | ID | Access |
| --- | --- | --- |
| Herdr Read Only | `herdr-read-only` | Exactly eight read tools, no other apps, no events |
| Herdr Control | `herdr-control` | Exactly 13 tools, no other apps, no events |

The adjacent JSON files are complete create-request bodies for Executor's `mcpConnections.create` API.
They use explicit tool names instead of `all` or `readOnly`, so later tools require a deliberate profile update.
Both profiles use the account-free app target. Every write tool still requires the app's approval policy.

## Create from your browser

Open `https://v36372-executor.exe.xyz/org/executor/connect` and sign in to Executor.
Under **Scoped connections**, create each profile and select only **Herdr SDK**.
Choose specific tools and match the names in its JSON file. Leave events and every other app disabled.
The read-only profile must exclude `herdr_workspace_create`, `herdr_pane_split`, `herdr_pane_send_text`, `herdr_pane_send_keys`, and `herdr_agent_prompt`.

Executor's create, list, and update endpoints require a signed-in browser session. An owner PAT returns 401 for these endpoints.
Do not bypass that restriction through database edits or synthetic sessions.
For an authenticated browser API client, POST the JSON to `/api/organizations/IWiWEyVV4RN5tdxbhig8EUkJ9PhwpjRF/mcp-connections`.
If an ID exists, inspect it first. Do not overwrite another profile automatically.

## Connect agents

Use the exact URL that Executor returns for each profile. Clients must sign in through OAuth.
The URL ends with `/mcp?connection=herdr-read-only` or `/mcp?connection=herdr-control` when those IDs are selected.
For control, choose browser approval delivery when you need the approval decision outside the agent.
The mode then forms part of the OAuth grant. Reauthorize if you change it.

WARNING: A PAT is not a read-only profile credential. Executor does not apply scoped-connection limits to PATs.
Do not supply the existing owner PAT to read-only clients, even with the read-only URL.
Read-only access can expose terminal secrets. It does not hide selected panes or redact terminal content.

## Verify before use

Through the read-only OAuth grant, discover exactly eight Herdr tools and no other apps.
An explicit call to any excluded write tool must fail, even if the caller knows its name.
Through the control grant, discover 13 tools and confirm a mutation requires approval before dispatch.
Changing the scoped URL must not broaden the same grant. Revocation must stop subsequent requests.

Local tests validate both JSON allowlists against actual MCP discovery with isolated sockets.
Those tests do not establish that the profiles exist or prove Executor's OAuth enforcement.
An end-to-end profile test requires the signed-in browser flow.

Reference: https://executor.sh/docs/mcp#scoped-connections
