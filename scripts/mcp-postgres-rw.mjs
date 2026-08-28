#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const serverInfo = {
  name: 'pos-postgres-rw',
  version: '1.0.0',
};

const protocolVersion = '2024-11-05';
const rootDir =
  process.env.MCP_POSTGRES_PROJECT_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

loadEnv(path.join(rootDir, '.env'));

const maxRowsDefault = numberFromEnv('MCP_POSTGRES_MAX_ROWS', 200);
const statementTimeoutMs = numberFromEnv('MCP_POSTGRES_STATEMENT_TIMEOUT_MS', 15000);
const allowDdl = /^(1|true|yes)$/i.test(process.env.MCP_POSTGRES_ALLOW_DDL ?? '');

const pool = new Pool({
  host: requireEnv('DATABASE_HOST'),
  port: numberFromEnv('DATABASE_PORT', 5432),
  user: requireEnv('DATABASE_USER'),
  password: requireEnv('DATABASE_PASSWORD'),
  database: requireEnv('DATABASE_NAME'),
  max: numberFromEnv('MCP_POSTGRES_POOL_MAX', 3),
  statement_timeout: statementTimeoutMs,
  query_timeout: statementTimeoutMs + 1000,
  ssl: sslConfig(),
});

const tools = [
  {
    name: 'postgres_execute',
    description:
      'Execute a parameterized PostgreSQL statement against the POS database. SELECT, INSERT, UPDATE, DELETE, and WITH are allowed. DDL is blocked unless MCP_POSTGRES_ALLOW_DDL=true.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'SQL statement to execute. Use $1, $2, etc. for parameters.',
        },
        params: {
          type: 'array',
          description: 'Optional positional parameters for the SQL statement.',
          items: {},
          default: [],
        },
        maxRows: {
          type: 'integer',
          description: 'Maximum number of returned rows to include in the response.',
          minimum: 1,
          maximum: 1000,
          default: maxRowsDefault,
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'postgres_schema',
    description: 'List non-system PostgreSQL tables and columns in the POS database.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Optional schema name. Defaults to every non-system schema.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'postgres_ping',
    description: 'Check that the POS PostgreSQL database connection is reachable.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    respondError(null, -32700, `Invalid JSON: ${error.message}`);
    return;
  }

  if (message.id === undefined) {
    return;
  }

  try {
    const result = await handleRequest(message.method, message.params ?? {});
    respond(message.id, result);
  } catch (error) {
    respondError(message.id, -32000, error.message);
  }
});
rl.on('close', shutdown);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function handleRequest(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools };
    case 'tools/call':
      return callTool(params.name, params.arguments ?? {});
    default:
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'postgres_execute':
      return executeSql(args);
    case 'postgres_schema':
      return describeSchema(args);
    case 'postgres_ping':
      return pingDatabase();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function executeSql(args) {
  const sql = String(args.sql ?? '').trim();
  if (!sql) throw new Error('sql is required.');

  const params = Array.isArray(args.params) ? args.params : [];
  const maxRows = clamp(Number(args.maxRows ?? maxRowsDefault), 1, 1000);

  validateSql(sql);

  const result = await pool.query({
    text: sql,
    values: params,
  });

  return textContent(
    JSON.stringify(
      {
        command: result.command,
        rowCount: result.rowCount,
        fieldNames: result.fields?.map((field) => field.name) ?? [],
        rows: result.rows.slice(0, maxRows),
        truncated: result.rows.length > maxRows,
      },
      null,
      2,
    ),
  );
}

async function describeSchema(args) {
  const schema = args.schema ? String(args.schema) : null;
  const result = await pool.query(
    `
      select
        c.table_schema,
        c.table_name,
        c.column_name,
        c.ordinal_position,
        c.data_type,
        c.udt_name,
        c.is_nullable,
        c.column_default
      from information_schema.columns c
      where c.table_schema not in ('pg_catalog', 'information_schema')
        and ($1::text is null or c.table_schema = $1)
      order by c.table_schema, c.table_name, c.ordinal_position
    `,
    [schema],
  );

  return textContent(JSON.stringify({ columns: result.rows }, null, 2));
}

async function pingDatabase() {
  const result = await pool.query('select current_database() as database, current_user as user, now() as server_time');
  return textContent(JSON.stringify(result.rows[0], null, 2));
}

function validateSql(sql) {
  const normalized = stripSqlNoise(sql);

  if (hasMultipleStatements(normalized)) {
    throw new Error('Only one SQL statement is allowed per call.');
  }

  const firstKeyword = normalized.trim().match(/^([a-z]+)/i)?.[1]?.toLowerCase();
  const allowedStarts = allowDdl
    ? ['select', 'with', 'insert', 'update', 'delete', 'explain', 'show', 'create', 'alter', 'drop', 'truncate']
    : ['select', 'with', 'insert', 'update', 'delete', 'explain', 'show'];

  if (!firstKeyword || !allowedStarts.includes(firstKeyword)) {
    throw new Error(
      allowDdl
        ? 'SQL must start with SELECT, WITH, INSERT, UPDATE, DELETE, EXPLAIN, SHOW, CREATE, ALTER, DROP, or TRUNCATE.'
        : 'SQL must start with SELECT, WITH, INSERT, UPDATE, DELETE, EXPLAIN, or SHOW.',
    );
  }

  if (!allowDdl && /\b(alter|create|drop|truncate|grant|revoke|vacuum|reindex|cluster|copy|call|do|listen|notify)\b/i.test(normalized)) {
    throw new Error('DDL and administrative SQL are blocked. Set MCP_POSTGRES_ALLOW_DDL=true to allow them.');
  }

  if (/\b(begin|commit|rollback|savepoint|release\s+savepoint|prepare\s+transaction)\b/i.test(normalized)) {
    throw new Error('Transaction control statements are not allowed in this MCP tool.');
  }
}

function stripSqlNoise(sql) {
  let output = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        output += ' ';
        index += 1;
      }
      if (index < sql.length) {
        output += '  ';
        index += 2;
      }
      continue;
    }

    if (char === "'") {
      output += ' ';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          output += '  ';
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          output += ' ';
          index += 1;
          break;
        }
        output += ' ';
        index += 1;
      }
      continue;
    }

    if (char === '"') {
      output += ' ';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          output += '  ';
          index += 2;
          continue;
        }
        if (sql[index] === '"') {
          output += ' ';
          index += 1;
          break;
        }
        output += ' ';
        index += 1;
      }
      continue;
    }

    if (char === '$') {
      const tagMatch = sql.slice(index).match(/^\$[a-z_][a-z0-9_]*\$|^\$\$/i);
      if (tagMatch) {
        const tag = tagMatch[0];
        output += ' '.repeat(tag.length);
        index += tag.length;
        const end = sql.indexOf(tag, index);
        if (end === -1) {
          output += ' '.repeat(sql.length - index);
          break;
        }
        output += ' '.repeat(end - index + tag.length);
        index = end + tag.length;
        continue;
      }
    }

    output += char;
    index += 1;
  }

  return output;
}

function hasMultipleStatements(sql) {
  const firstSemicolon = sql.indexOf(';');
  if (firstSemicolon === -1) return false;
  return sql.slice(firstSemicolon + 1).trim().length > 0;
}

function textContent(text) {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function shutdown() {
  await pool.end();
  process.exit(0);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Add it to ${path.join(rootDir, '.env')} or the MCP server environment.`);
  }
  return value;
}

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number.`);
  }
  return parsed;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    process.env[key] = unquoteEnvValue(rawValue.trim());
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function sslConfig() {
  const value = process.env.DATABASE_SSL;
  if (!value || /^(0|false|no)$/i.test(value)) return undefined;
  return {
    rejectUnauthorized: !/^(require|true|1|yes)$/i.test(value)
      ? value !== 'no-verify'
      : false,
  };
}
