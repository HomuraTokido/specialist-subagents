// R-6: the tools a Lead seat sees on this service's MCP server, the ones it dispatches and checks
// with. mcp-stdio.mjs shows a Lead only these; cli-runner.mjs checks that Antigravity is allowed to call
// each of them, since agy's headless mode denies an MCP tool it has no grant for (2026-10-22).
export const LEAD_TOOLS = ['seat_start', 'task_wait', 'task_result', 'seat_show', 'seat_list', 'seat_verdict', 'role_list', 'dispatch_guide'];
