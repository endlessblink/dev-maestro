#!/usr/bin/env node
/**
 * Dev Maestro MCP Server
 * Provides Claude Code integration via Model Context Protocol
 *
 * Tools:
 * - maestro_get_tasks: Get all tasks from MASTER_PLAN.md
 * - maestro_get_task: Get a specific task by ID
 * - maestro_update_status: Update task status
 * - maestro_add_task: Add a new task
 * - maestro_health: Get project health report
 * - maestro_next_id: Get the next available task ID
 */

const http = require('http');
const readline = require('readline');

const API_BASE = process.env.DEV_MAESTRO_URL || 'http://localhost:6010';

// Helper to make API requests
async function apiRequest(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, API_BASE);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve({ raw: data });
                }
            });
        });

        req.on('error', (e) => reject(e));

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// Tool definitions
const tools = [
    {
        name: 'maestro_get_tasks',
        description: 'Get all tasks from MASTER_PLAN.md. Returns tasks grouped by status (backlog, in_progress, blocked, review, done).',
        inputSchema: {
            type: 'object',
            properties: {
                status: {
                    type: 'string',
                    description: 'Optional: Filter by status (backlog, in_progress, blocked, review, done)',
                    enum: ['backlog', 'in_progress', 'blocked', 'review', 'done']
                }
            }
        }
    },
    {
        name: 'maestro_get_task',
        description: 'Get details of a specific task by ID (e.g., TASK-001)',
        inputSchema: {
            type: 'object',
            properties: {
                taskId: {
                    type: 'string',
                    description: 'Task ID (e.g., TASK-001)'
                }
            },
            required: ['taskId']
        }
    },
    {
        name: 'maestro_update_status',
        description: 'Update the status of a task. This modifies MASTER_PLAN.md directly.',
        inputSchema: {
            type: 'object',
            properties: {
                taskId: {
                    type: 'string',
                    description: 'Task ID (e.g., TASK-001)'
                },
                status: {
                    type: 'string',
                    description: 'New status',
                    enum: ['backlog', 'in_progress', 'blocked', 'review', 'done']
                }
            },
            required: ['taskId', 'status']
        }
    },
    {
        name: 'maestro_next_id',
        description: 'Get the next available task ID for creating a new task',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'maestro_health',
        description: 'Get project health report including TypeScript errors, ESLint issues, outdated packages, and security audit',
        inputSchema: {
            type: 'object',
            properties: {
                quick: {
                    type: 'boolean',
                    description: 'If true, return cached results for faster response'
                }
            }
        }
    },
    {
        name: 'maestro_master_plan',
        description: 'Get the raw MASTER_PLAN.md content',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    }
];

// Tool handlers
async function handleTool(name, args) {
    try {
        switch (name) {
            case 'maestro_get_tasks': {
                const result = await apiRequest('/api/master-plan');
                if (result.error) return { error: result.error };

                // Parse tasks from content
                const content = result.content || '';
                const tasks = parseTasksFromMarkdown(content);

                if (args.status) {
                    return { tasks: tasks.filter(t => t.status === args.status) };
                }
                return { tasks };
            }

            case 'maestro_get_task': {
                const result = await apiRequest('/api/master-plan');
                if (result.error) return { error: result.error };

                const tasks = parseTasksFromMarkdown(result.content || '');
                const task = tasks.find(t => t.id === args.taskId);

                if (!task) return { error: `Task ${args.taskId} not found` };
                return { task };
            }

            case 'maestro_update_status': {
                const statusMap = {
                    'backlog': 'backlog',
                    'in_progress': 'in-progress',
                    'blocked': 'blocked',
                    'review': 'review',
                    'done': 'done'
                };

                const result = await apiRequest(
                    `/api/task/${args.taskId}/status`,
                    'POST',
                    { status: statusMap[args.status] || args.status }
                );
                return result;
            }

            case 'maestro_next_id': {
                const result = await apiRequest('/api/next-id');
                return result;
            }

            case 'maestro_health': {
                const endpoint = args.quick ? '/api/health/cached' : '/api/health/quick';
                const result = await apiRequest(endpoint);
                return result;
            }

            case 'maestro_master_plan': {
                const result = await apiRequest('/api/master-plan');
                return result;
            }

            default:
                return { error: `Unknown tool: ${name}` };
        }
    } catch (error) {
        return { error: `API error: ${error.message}. Is Dev Maestro running on ${API_BASE}?` };
    }
}

// Parse MASTER_PLAN.md content to extract tasks
function parseTasksFromMarkdown(content) {
    const tasks = [];
    const taskRegex = /^###\s+(~~)?(TASK-\d+)(~~)?:\s*(.+)$/gm;

    let match;
    while ((match = taskRegex.exec(content)) !== null) {
        const isCompleted = match[1] === '~~' && match[3] === '~~';
        const id = match[2];
        const titleLine = match[4];

        // Determine status from markers
        let status = 'backlog';
        if (isCompleted || titleLine.includes('✅ DONE')) {
            status = 'done';
        } else if (titleLine.includes('🔄 IN PROGRESS')) {
            status = 'in_progress';
        } else if (titleLine.includes('⏸️ PAUSED')) {
            status = 'blocked';
        } else if (titleLine.includes('👀 REVIEW')) {
            status = 'review';
        }

        // Extract title without status marker
        const title = titleLine
            .replace(/\s*\(🔄 IN PROGRESS\)\s*/g, '')
            .replace(/\s*\(⏸️ PAUSED\)\s*/g, '')
            .replace(/\s*\(👀 REVIEW\)\s*/g, '')
            .replace(/\s*\(✅ DONE\)\s*/g, '')
            .trim();

        tasks.push({ id, title, status, isCompleted });
    }

    return tasks;
}

// MCP Protocol handler
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

function sendResponse(response) {
    process.stdout.write(JSON.stringify(response) + '\n');
}

rl.on('line', async (line) => {
    try {
        const message = JSON.parse(line);

        switch (message.method) {
            case 'initialize':
                sendResponse({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: {
                            tools: {}
                        },
                        serverInfo: {
                            name: 'dev-maestro',
                            version: '1.0.0'
                        }
                    }
                });
                break;

            case 'tools/list':
                sendResponse({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { tools }
                });
                break;

            case 'tools/call':
                const toolResult = await handleTool(
                    message.params.name,
                    message.params.arguments || {}
                );
                sendResponse({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(toolResult, null, 2)
                        }]
                    }
                });
                break;

            case 'notifications/initialized':
                // No response needed
                break;

            default:
                sendResponse({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: {
                        code: -32601,
                        message: `Method not found: ${message.method}`
                    }
                });
        }
    } catch (error) {
        sendResponse({
            jsonrpc: '2.0',
            id: null,
            error: {
                code: -32700,
                message: `Parse error: ${error.message}`
            }
        });
    }
});

// Handle process signals gracefully
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
