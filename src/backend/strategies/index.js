/**
 * @fileoverview 负载均衡策略模块
 * @description Worker 选择策略，用于任务分发时智能选择 Worker。
 *
 * 策略类型：
 * - least_busy: 优先选择当前任务最少的 Worker
 * - round_robin: 轮询分配
 * - random: 随机分配
 */

// ==========================================
// 策略枚举
// ==========================================

/**
 * 策略枚举
 * @readonly
 */
export const STRATEGIES = {
    LEAST_BUSY: 'least_busy',
    ROUND_ROBIN: 'round_robin',
    RANDOM: 'random',
};

// ==========================================
// 策略选择器
// ==========================================

/**
 * 创建策略选择器
 * @param {string} strategy - 策略名称
 * @returns {object} 策略选择器实例
 */
export function createStrategySelector(strategy) {
    let roundRobinIndex = 0;

    return {
        /**
         * 根据策略排序候选列表
         * @param {object[]} candidates - 候选列表（需有 busyCount 属性）
         * @returns {object[]} 排序后的候选列表
         */
        sort(candidates) {
            if (candidates.length <= 1) return candidates;

            switch (strategy) {
                case STRATEGIES.ROUND_ROBIN: {
                    const start = roundRobinIndex % candidates.length;
                    roundRobinIndex++;
                    return [...candidates.slice(start), ...candidates.slice(0, start)];
                }
                case STRATEGIES.RANDOM: {
                    return [...candidates].sort(() => Math.random() - 0.5);
                }
                case STRATEGIES.LEAST_BUSY:
                default: {
                    return [...candidates].sort((a, b) => (a.busyCount || 0) - (b.busyCount || 0));
                }
            }
        },

        /**
         * 选择单个最优候选
         * @param {object[]} candidates - 候选列表
         * @returns {object} 选中的候选
         */
        select(candidates) {
            if (candidates.length === 0) return null;
            if (candidates.length === 1) return candidates[0];
            return this.sort(candidates)[0];
        }
    };
}
