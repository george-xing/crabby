#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initMemoryDb, remember, recall, listMemories, forget } from "../../memory/db.js";

const dataDir = process.env.DATA_DIR || "./data";
initMemoryDb(dataDir);

const server = new McpServer({
  name: "crabby-memory",
  version: "0.1.0",
});

server.tool(
  "remember",
  "Store a memory about the user — preferences, facts, contacts, outcomes, or any useful context. Categories: preference, fact, contact, outcome, routine, interest",
  {
    category: z.string().describe("Category: preference, fact, contact, outcome, routine, interest"),
    key: z.string().describe("Short identifier for this memory, e.g. 'favorite_cuisine' or 'dentist_name'"),
    value: z.string().describe("The actual memory content"),
  },
  async ({ category, key, value }) => {
    remember(category, key, value);
    return { content: [{ type: "text" as const, text: `Remembered: [${category}] ${key} = ${value}` }] };
  },
);

server.tool(
  "recall",
  "Search memories by keyword. Returns matching memories across all categories.",
  {
    query: z.string().describe("Search term to find in memories"),
  },
  async ({ query }) => {
    const results = recall(query);
    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "No memories found matching that query." }] };
    }
    const formatted = results
      .map((r) => `[${r.category}] ${r.key}: ${r.value} (updated: ${r.updated_at})`)
      .join("\n");
    return { content: [{ type: "text" as const, text: formatted }] };
  },
);

server.tool(
  "list_memories",
  "List all stored memories, optionally filtered by category.",
  {
    category: z.string().optional().describe("Optional category filter: preference, fact, contact, outcome, routine, interest"),
  },
  async ({ category }) => {
    const results = listMemories(category);
    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: category ? `No memories in category '${category}'.` : "No memories stored yet." }] };
    }
    const formatted = results
      .map((r) => `[${r.category}] ${r.key}: ${r.value}`)
      .join("\n");
    return { content: [{ type: "text" as const, text: formatted }] };
  },
);

server.tool(
  "forget",
  "Delete a specific memory by category and key.",
  {
    category: z.string().describe("Category of the memory to forget"),
    key: z.string().describe("Key of the memory to forget"),
  },
  async ({ category, key }) => {
    const deleted = forget(category, key);
    return {
      content: [{ type: "text" as const, text: deleted ? `Forgot: [${category}] ${key}` : `No memory found: [${category}] ${key}` }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
