# Changelog

## 0.2.0

- The hook runs for every tool (matcher `*`), not only Bash. It redacts every string in the response, keeps the shape, and answers MCP tools through `updatedMCPToolOutput`.
- Fails closed for every shape. A response with no string of `minLength` or more exits silently.

## 0.1.0

- First release. A `PostToolUse` hook for Bash redacts known values from listed dotenv and JSON files and values that match 13 default patterns. It fails closed.
- `scripts/check.js` shows the loaded files and runs a self-test.
