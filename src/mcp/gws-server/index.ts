#!/usr/bin/env node
/**
 * MCP server wrapping @googleworkspace/cli (gws).
 * Exposes Google Workspace APIs as MCP tools that Claude can call.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const GWS_BIN = "npx";
const GWS_ARGS = ["gws"];

async function runGws(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(GWS_BIN, [...GWS_ARGS, ...args], {
      timeout: 30_000,
      env: process.env,
    });
    return stdout;
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    return `Error: ${error.stderr || error.message}`;
  }
}

const server = new McpServer({
  name: "gws-workspace",
  version: "0.1.0",
});

// --- Gmail ---

server.tool(
  "gmail_list_messages",
  "List recent emails. Returns message IDs and snippets.",
  {
    query: z.string().optional().describe("Gmail search query, e.g. 'is:unread', 'from:alice@example.com', 'subject:invoice'"),
    maxResults: z.number().optional().default(10).describe("Max messages to return"),
  },
  async ({ query, maxResults }) => {
    const params: Record<string, unknown> = { userId: "me", maxResults };
    if (query) params.q = query;
    const result = await runGws(["gmail", "users", "messages", "list", "--params", JSON.stringify(params)]);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

server.tool(
  "gmail_get_message",
  "Get full details of a specific email by message ID.",
  {
    messageId: z.string().describe("The Gmail message ID"),
  },
  async ({ messageId }) => {
    const result = await runGws([
      "gmail", "users", "messages", "get",
      "--params", JSON.stringify({ userId: "me", id: messageId, format: "full" }),
    ]);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

server.tool(
  "gmail_send",
  "Send an email. The raw field should be a base64url-encoded RFC 2822 message.",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body (plain text)"),
  },
  async ({ to, subject, body }) => {
    const message = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
    const raw = Buffer.from(message).toString("base64url");
    const result = await runGws([
      "gmail", "users", "messages", "send",
      "--params", JSON.stringify({ userId: "me" }),
      "--json", JSON.stringify({ raw }),
    ]);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

// --- Google Drive ---

server.tool(
  "drive_list_files",
  "List files in Google Drive. Supports search queries.",
  {
    query: z.string().optional().describe("Drive search query, e.g. \"name contains 'report'\" or \"mimeType='application/pdf'\""),
    maxResults: z.number().optional().default(10).describe("Max files to return"),
  },
  async ({ query, maxResults }) => {
    const params: Record<string, unknown> = { pageSize: maxResults };
    if (query) params.q = query;
    const result = await runGws(["drive", "files", "list", "--params", JSON.stringify(params)]);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

server.tool(
  "drive_get_file",
  "Get metadata for a specific file by ID.",
  {
    fileId: z.string().describe("The Google Drive file ID"),
  },
  async ({ fileId }) => {
    const result = await runGws([
      "drive", "files", "get",
      "--params", JSON.stringify({ fileId, fields: "id,name,mimeType,modifiedTime,size,webViewLink" }),
    ]);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

server.tool(
  "drive_read_doc",
  "Read the content of a Google Doc by file ID.",
  {
    documentId: z.string().describe("The Google Docs document ID"),
  },
  async ({ documentId }) => {
    const result = await runGws([
      "docs", "documents", "get",
      "--params", JSON.stringify({ documentId }),
    ]);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

// --- Google Calendar ---

server.tool(
  "calendar_list_events",
  "List upcoming calendar events.",
  {
    maxResults: z.number().optional().default(10).describe("Max events to return"),
    timeMin: z.string().optional().describe("Start time (ISO 8601), defaults to now"),
  },
  async ({ maxResults, timeMin }) => {
    const params: Record<string, unknown> = {
      calendarId: "primary",
      maxResults,
      orderBy: "startTime",
      singleEvents: true,
      timeMin: timeMin || new Date().toISOString(),
    };
    const result = await runGws(["calendar", "events", "list", "--params", JSON.stringify(params)]);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

server.tool(
  "calendar_create_event",
  "Create a new calendar event.",
  {
    summary: z.string().describe("Event title"),
    startTime: z.string().describe("Start time (ISO 8601)"),
    endTime: z.string().describe("End time (ISO 8601)"),
    description: z.string().optional().describe("Event description"),
    location: z.string().optional().describe("Event location"),
  },
  async ({ summary, startTime, endTime, description, location }) => {
    const event: Record<string, unknown> = {
      summary,
      start: { dateTime: startTime },
      end: { dateTime: endTime },
    };
    if (description) event.description = description;
    if (location) event.location = location;
    const result = await runGws([
      "calendar", "events", "insert",
      "--params", JSON.stringify({ calendarId: "primary" }),
      "--json", JSON.stringify(event),
    ]);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

// --- Google Sheets ---

server.tool(
  "sheets_read",
  "Read data from a Google Sheets spreadsheet.",
  {
    spreadsheetId: z.string().describe("The spreadsheet ID"),
    range: z.string().describe("A1 notation range, e.g. 'Sheet1!A1:D10'"),
  },
  async ({ spreadsheetId, range }) => {
    const result = await runGws([
      "sheets", "spreadsheets", "values", "get",
      "--params", JSON.stringify({ spreadsheetId, range }),
    ]);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

// --- Generic gws command ---

server.tool(
  "gws_raw",
  "Run any gws command directly. Use this for APIs not covered by other tools. Example args: ['drive', 'files', 'list', '--params', '{\"pageSize\": 5}']",
  {
    args: z.array(z.string()).describe("Arguments to pass to gws CLI"),
  },
  async ({ args }) => {
    const result = await runGws(args);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
