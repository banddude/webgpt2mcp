/**
 * @fileoverview 请求统计管理模块
 * @description 按日期存储成功/失败请求计数，支持日期范围查询和删除
 */

import { promises as fs } from 'fs';
import path from 'path';

// 日志目录
const LOG_DIR = path.join(process.cwd(), 'data', 'logs');

/**
 * 获取指定日期的统计文件路径
 * @param {string} date - YYYY-MM-DD 格式的日期
 * @returns {string}
 */
function getStatsFilePath(date) {
    return path.join(LOG_DIR, `stats_${date}.json`);
}

/**
 * 获取今日日期字符串
 * @returns {string} YYYY-MM-DD 格式
 */
function getTodayDateStr() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 内存缓存：今日统计
let todayStats = { success: 0, failed: 0 };
let todayDate = getTodayDateStr();

/**
 * 确保日志目录存在
 */
async function ensureLogDir() {
    try {
        await fs.mkdir(LOG_DIR, { recursive: true });
    } catch { /* 忽略已存在错误 */ }
}

/**
 * 检查并切换日期（跨天时自动重置缓存）
 */
async function checkDateRollover() {
    const currentDate = getTodayDateStr();
    if (currentDate !== todayDate) {
        // 保存昨日数据
        await saveStats(todayDate, todayStats);
        // 重置为新的一天
        todayDate = currentDate;
        todayStats = { success: 0, failed: 0 };
        // 尝试加载今日已有数据
        await loadTodayStats();
    }
}

/**
 * 保存统计到文件
 * @param {string} date - 日期
 * @param {object} stats - 统计数据
 */
async function saveStats(date, stats) {
    await ensureLogDir();
    const filePath = getStatsFilePath(date);
    await fs.writeFile(filePath, JSON.stringify(stats, null, 2));
}

/**
 * 加载今日统计（服务启动时调用）
 */
export async function loadTodayStats() {
    await ensureLogDir();
    todayDate = getTodayDateStr();
    const filePath = getStatsFilePath(todayDate);

    try {
        const data = await fs.readFile(filePath, 'utf-8');
        todayStats = JSON.parse(data);
    } catch {
        todayStats = { success: 0, failed: 0 };
    }

    return todayStats;
}

/**
 * 增加成功计数
 */
export async function incrementSuccess() {
    await checkDateRollover();
    todayStats.success++;
    await saveStats(todayDate, todayStats);
}

/**
 * 增加失败计数
 */
export async function incrementFailed() {
    await checkDateRollover();
    todayStats.failed++;
    await saveStats(todayDate, todayStats);
}

/**
 * 获取今日统计
 * @returns {{success: number, failed: number}}
 */
export function getTodayStats() {
    // 检查是否跨天（同步版本，仅检查不保存）
    const currentDate = getTodayDateStr();
    if (currentDate !== todayDate) {
        // 返回空数据，等待下次写入时触发跨天处理
        return { success: 0, failed: 0 };
    }
    return { ...todayStats };
}

/**
 * 获取日期范围内的汇总统计
 * @param {string} startDate - 开始日期 YYYY-MM-DD
 * @param {string} endDate - 结束日期 YYYY-MM-DD
 * @returns {Promise<{success: number, failed: number, days: number}>}
 */
export async function getStatsRange(startDate, endDate) {
    const result = { success: 0, failed: 0, days: 0 };

    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        const filePath = getStatsFilePath(dateStr);

        try {
            const data = await fs.readFile(filePath, 'utf-8');
            const stats = JSON.parse(data);
            result.success += stats.success || 0;
            result.failed += stats.failed || 0;
            result.days++;
        } catch {
            // 文件不存在，跳过
        }
    }

    return result;
}

/**
 * 删除日期范围内的统计文件
 * @param {string} startDate - 开始日期 YYYY-MM-DD
 * @param {string} endDate - 结束日期 YYYY-MM-DD
 * @returns {Promise<{deleted: number}>}
 */
export async function clearStatsRange(startDate, endDate) {
    let deleted = 0;

    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        const filePath = getStatsFilePath(dateStr);

        try {
            await fs.unlink(filePath);
            deleted++;

            // 如果删除的是今日文件，重置内存缓存
            if (dateStr === todayDate) {
                todayStats = { success: 0, failed: 0 };
            }
        } catch {
            // 文件不存在，跳过
        }
    }

    return { deleted };
}
