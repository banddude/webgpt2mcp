/**
 * @fileoverview 鉴权中间件
 * @description 提取自 routes.js 的鉴权逻辑
 */

import { sendApiError } from '../respond.js';
import { ERROR_CODES } from '../errors.js';

/**
 * 鉴权检查
 * @param {import('http').IncomingMessage} req - HTTP 请求
 * @param {string} authToken - 有效的认证令牌
 * @returns {boolean} 是否通过鉴权
 */
export function checkAuth(req, authToken) {
    const authHeader = req.headers['authorization'];
    return authHeader === `Bearer ${authToken}`;
}

/**
 * 创建鉴权中间件
 * @param {string} authToken - 认证令牌
 * @returns {Function} 中间件函数
 */
export function createAuthMiddleware(authToken) {
    /**
     * 鉴权中间件
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse} res
     * @returns {boolean} 是否通过鉴权
     */
    return function authMiddleware(req, res) {
        // 如果 authToken 为空，跳过认证（允许所有请求）
        if (!authToken) {
            return true;
        }
        if (!checkAuth(req, authToken)) {
            sendApiError(res, { code: ERROR_CODES.UNAUTHORIZED });
            return false;
        }
        return true;
    };
}
