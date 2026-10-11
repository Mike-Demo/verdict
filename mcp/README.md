# Verdict MCP server

Minimal [Model Context Protocol](https://modelcontextprotocol.io) server over stdio — zero dependencies, plain Node 18+.

## Tools

| Tool | Description |
|---|---|
| `declare_intent` | Declare a new agent intent (`title`, `paths[]`, `agent`, `description?`). Heat is computed against active intents. |
| `list_cards` | Decision cards — one per intent with an evaluated candidate (gates, judge scores, cost, scope flags). |
| `get_ledger` | Append-only decision ledger. |

## Configure

```jsonc
// Claude Desktop / MCP client config
{
  "mcpServers": {
    "verdict": {
      "command": "node",
      "args": ["/path/to/verdict/mcp/server.js"],
      "env": { "VERDICT_API": "https://verdict.hey-demo-827.workers.dev" }
    }
  }
}
```

`VERDICT_API` defaults to the live prototype Worker.
