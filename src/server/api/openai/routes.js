/**
 * @fileoverview OpenAI 兼容 API 路由
 * @description 处理 /v1 路径下的所有 API 请求
 */

import crypto from 'crypto';
import { logger } from '../../../utils/logger.js';
import { ERROR_CODES } from '../../errors.js';
import { sendJson, sendApiError } from '../../respond.js';
import { parseRequest } from './parse.js';

/**
 * 创建 OpenAI API 路由处理器
 * @param {object} context - 路由上下文
 * @returns {Function} 路由处理函数
 */
export function createOpenAIRouter(context) {
    const {
        backendName,
        getModels,
        getImagePolicy,
        getModelType,
        tempDir,
        imageLimit,
        queueManager
    } = context;

    /**
     * 处理 GET /v1/models
     */
    function handleModels(res) {
        const models = getModels();
        sendJson(res, 200, models);
    }

    /**
     * 处理 GET /v1/cookies
     */
    async function handleCookies(res, requestId, workerName, domain) {
        const poolContext = queueManager.getPoolContext();

        if (!poolContext?.poolManager) {
            sendApiError(res, { code: ERROR_CODES.BROWSER_NOT_INITIALIZED });
            return;
        }

        try {
            const result = await queueManager.getWorkerCookies(workerName, domain);
            sendJson(res, 200, {
                worker: result.worker,
                cookies: result.cookies
            });
        } catch (err) {
            logger.error('服务器', '获取 Cookies 失败', { id: requestId, error: err.message });

            if (err.message.includes('Worker 不存在') || err.message.includes('Worker not found')) {
                sendApiError(res, {
                    code: ERROR_CODES.INVALID_MODEL,
                    message: err.message
                });
            } else {
                sendApiError(res, {
                    code: ERROR_CODES.INTERNAL_ERROR,
                    message: err.message
                });
            }
        }
    }

    /**
     * 处理 POST /v1/chat/completions
     */
    async function handleChatCompletions(req, res, requestId) {
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }

        try {
            const body = Buffer.concat(chunks).toString();
            const data = JSON.parse(body);
            const isStreaming = data.stream === true;

            // 限流检查
            if (!isStreaming && !queueManager.canAcceptNonStreaming()) {
                const status = queueManager.getStatus();
                logger.warn('服务器', '非流式请求被拒绝 (队列已满)', { id: requestId, queueSize: status.total });
                sendApiError(res, {
                    code: ERROR_CODES.SERVER_BUSY,
                    message: `服务器繁忙（队列: ${status.total}/${queueManager.maxQueueSize}）。请使用流式模式 (stream: true) 或稍后重试。`
                });
                return;
            }

            // 设置 SSE 响应头
            if (isStreaming) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
            }

            // 解析请求
            const parseResult = await parseRequest(data, {
                tempDir,
                imageLimit,
                backendName,
                getSupportedModels: getModels,
                getImagePolicy,
                getModelType,
                requestId,
                logger
            });

            if (!parseResult.success) {
                sendApiError(res, {
                    code: parseResult.error.code,
                    message: parseResult.error.error,
                    isStreaming
                });
                return;
            }

            const { prompt, imagePaths, modelId, modelName } = parseResult.data;
            const reasoning = data.reasoning === true;
            const conversationUrl = data.conversation_url ||
                data.conversationUrl ||
                data.metadata?.conversation_url ||
                data.metadata?.chatgpt_conversation_url ||
                null;

            logger.info('服务器', `[队列] 请求入队: ${prompt.slice(0, 100)}...`, { id: requestId, images: imagePaths.length });

            // 加入队列
            queueManager.addTask({
                req,
                res,
                prompt,
                imagePaths,
                modelId,
                modelName,
                id: requestId,
                isStreaming,
                reasoning,
                conversationUrl
            });

        } catch (err) {
            logger.error('服务器', '请求处理失败', { id: requestId, error: err.message });
            sendApiError(res, {
                code: ERROR_CODES.INTERNAL_ERROR,
                message: err.message
            });
        }
    }

    /**
     * Convert the Responses API input shape into the chat shape understood by
     * the existing browser queue. Codex 0.144+ uses Responses exclusively,
     * while this gateway historically exposed Chat Completions only.
     */
    function responseContentToChat(content) {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';

        const parts = content.map(part => {
            if (!part || typeof part !== 'object') return null;
            if (part.type === 'input_text' || part.type === 'text') {
                return { type: 'text', text: part.text || '' };
            }
            if (part.type === 'input_image' || part.type === 'image_url') {
                const url = part.image_url || part.image?.url || part.url;
                return url ? { type: 'image_url', image_url: { url } } : null;
            }
            return null;
        }).filter(Boolean);

        if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
        return parts;
    }

    function responsesInputToMessages(data) {
        const messages = [];

        if (typeof data.instructions === 'string' && data.instructions.trim()) {
            messages.push({ role: 'system', content: data.instructions });
        }

        const input = Array.isArray(data.input) ? data.input : [];
        for (const item of input) {
            if (typeof item === 'string') {
                messages.push({ role: 'user', content: item });
                continue;
            }
            if (!item || typeof item !== 'object') continue;

            if (item.type === 'message') {
                const role = item.role === 'developer' ? 'system' :
                    (['system', 'user', 'assistant'].includes(item.role) ? item.role : 'user');
                messages.push({ role, content: responseContentToChat(item.content) });
                continue;
            }

            // Preserve tool results as context text. The browser backend is a
            // text model and cannot execute Responses function calls itself.
            if (item.type === 'function_call_output') {
                messages.push({
                    role: 'user',
                    content: `Tool result:\n${typeof item.output === 'string' ? item.output : JSON.stringify(item.output)}`
                });
                continue;
            }

            if (item.type === 'input_text') {
                messages.push({ role: 'user', content: item.text || '' });
            }
        }

        return messages.filter(message => {
            if (typeof message.content === 'string') return message.content.length > 0;
            return Array.isArray(message.content) && message.content.length > 0;
        });
    }

    function supportedProxyModel(requestedModel) {
        const supported = getModels()?.data || [];
        if (supported.some(model => model.id === requestedModel)) return requestedModel;

        // The Codex profile's model name is a provider label, not a ChatGPT
        // Web selector name. Prefer the advertised Thinking model for that
        // alias, with a text model fallback if the selector changes.
        return supported.find(model => model.id === 'gpt-thinking')?.id ||
            supported.find(model => getModelType?.(model.id) === 'text')?.id ||
            requestedModel;
    }

    function responsesRequestToChat(data) {
        return {
            model: supportedProxyModel(data.model),
            messages: responsesInputToMessages(data),
            stream: data.stream === true,
            reasoning: false,
            metadata: data.metadata,
            conversation_url: data.metadata?.conversation_url || data.metadata?.chatgpt_conversation_url || null
        };
    }

    function responseMessage(responseId, modelName, text, status = 'completed') {
        const item = {
            id: `msg_${responseId}`,
            type: 'message',
            status,
            role: 'assistant',
            content: status === 'completed' ? [{ type: 'output_text', text, annotations: [] }] : []
        };

        return {
            id: responseId,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            status,
            model: modelName,
            output: status === 'completed' ? [item] : [],
            output_text: status === 'completed' ? text : '',
            error: null,
            incomplete_details: null,
            usage: null
        };
    }

    function createResponsesAdapter(res, data, requestId) {
        const responseId = `resp_${requestId}`;
        const modelName = data.model || 'chatgpt_text';
        const isStreaming = data.stream === true;
        let started = false;
        let completed = false;
        let statusCode = 200;
        let bufferedText = '';

        function emit(type, payload) {
            if (res.writableEnded) return;
            res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
        }

        function startStream() {
            if (started || !isStreaming) return;
            started = true;
            const itemId = `msg_${responseId}`;
            emit('response.created', { response: responseMessage(responseId, modelName, '', 'in_progress') });
            emit('response.in_progress', { response: responseMessage(responseId, modelName, '', 'in_progress') });
            emit('response.output_item.added', {
                output_index: 0,
                item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
            });
            emit('response.content_part.added', {
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] }
            });
        }

        function finishStream() {
            if (completed || res.writableEnded) return;
            completed = true;
            const itemId = `msg_${responseId}`;
            emit('response.output_text.done', {
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                text: bufferedText
            });
            emit('response.content_part.done', {
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: bufferedText, annotations: [] }
            });
            emit('response.output_item.done', {
                output_index: 0,
                item: responseMessage(responseId, modelName, bufferedText).output[0]
            });
            emit('response.completed', {
                response: responseMessage(responseId, modelName, bufferedText, 'completed')
            });
            res.end();
        }

        function failStream(error) {
            if (completed || res.writableEnded) return;
            completed = true;
            emit('response.failed', {
                response: {
                    ...responseMessage(responseId, modelName, '', 'failed'),
                    error: { message: error?.message || 'Upstream chat request failed', type: 'server_error' }
                }
            });
            res.end();
        }

        function handlePayload(payload) {
            if (!payload) return;
            if (payload.error) {
                failStream(payload.error);
                return;
            }

            const choice = payload.choices?.[0];
            const content = choice?.delta?.content ?? choice?.message?.content;
            if (typeof content === 'string' && content) {
                bufferedText += content;
                if (isStreaming) {
                    emit('response.output_text.delta', {
                        item_id: `msg_${responseId}`,
                        output_index: 0,
                        content_index: 0,
                        delta: content
                    });
                }
            }
        }

        return {
            get writableEnded() {
                return completed || res.writableEnded;
            },
            writeHead(status, headers) {
                statusCode = status;
                if (status === 200 && isStreaming) {
                    res.writeHead(status, {
                        ...headers,
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive'
                    });
                    startStream();
                } else {
                    res.writeHead(status, headers);
                }
            },
            write(chunk) {
                const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
                if (!isStreaming) return;
                for (const line of text.split(/\r?\n/)) {
                    if (line.startsWith(':')) {
                        if (!res.writableEnded) res.write(`${line}\n\n`);
                        continue;
                    }
                    if (!line.startsWith('data:')) continue;
                    const raw = line.slice(5).trim();
                    if (raw === '[DONE]') {
                        finishStream();
                        continue;
                    }
                    try {
                        handlePayload(JSON.parse(raw));
                    } catch {
                        // Ignore non-JSON SSE lines from the chat adapter.
                    }
                }
            },
            end(body) {
                if (completed || res.writableEnded) return;
                if (isStreaming) {
                    if (body) {
                        try { handlePayload(JSON.parse(Buffer.isBuffer(body) ? body.toString() : body)); } catch { }
                    }
                    finishStream();
                    return;
                }

                if (statusCode !== 200) {
                    res.end(body);
                    return;
                }

                try {
                    const payload = JSON.parse(Buffer.isBuffer(body) ? body.toString() : (body || '{}'));
                    if (payload.error) {
                        res.end(JSON.stringify(payload));
                        return;
                    }
                    handlePayload(payload);
                    res.end(JSON.stringify(responseMessage(responseId, modelName, bufferedText, 'completed')));
                } catch {
                    res.end(body);
                }
            }
        };
    }

    /**
     * Handle POST /v1/responses for current Codex clients.
     */
    async function handleResponses(req, res, requestId) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);

        try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const chatData = responsesRequestToChat(data);
            if (!chatData.messages.length) {
                sendApiError(res, { code: ERROR_CODES.NO_MESSAGES, message: 'Responses input did not contain messages' });
                return;
            }

            const adapter = createResponsesAdapter(res, data, requestId);
            const fakeReq = {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.from(JSON.stringify(chatData));
                }
            };
            await handleChatCompletions(fakeReq, adapter, requestId);
        } catch (err) {
            logger.error('服务器', 'Responses 请求处理失败', { id: requestId, error: err.message });
            sendApiError(res, { code: ERROR_CODES.INTERNAL_ERROR, message: err.message });
        }
    }

    /**
     * OpenAI API 路由处理函数
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse} res
     * @param {string} pathname - 去除 /v1 前缀后的路径
     * @param {URL} parsedUrl - 解析后的 URL 对象
     */
    return async function handleOpenAIRequest(req, res, pathname, parsedUrl) {
        const requestId = crypto.randomUUID().slice(0, 8);

        if (req.method === 'GET' && pathname === '/models') {
            handleModels(res);
        } else if (req.method === 'GET' && pathname === '/cookies') {
            const workerName = parsedUrl.searchParams.get('name');
            const domain = parsedUrl.searchParams.get('domain');
            await handleCookies(res, requestId, workerName, domain);
        } else if (req.method === 'POST' && pathname.startsWith('/chat/completions')) {
            await handleChatCompletions(req, res, requestId);
        } else if (req.method === 'POST' && pathname.startsWith('/responses')) {
            await handleResponses(req, res, requestId);
        } else {
            res.writeHead(404);
            res.end();
        }
    };
}
