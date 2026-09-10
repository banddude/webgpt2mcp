/** JSON responses for bounded website controls. */
import { getErrorDetails } from './errors.js';

export function sendJson(res, status, payload) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

export function sendApiError(res, { code, message, status } = {}) {
    const details = getErrorDetails(code);
    sendJson(res, status || details.status, { error: { message: message || details.message, type: details.type, code } });
}
