/**
 * @fileoverview PoolManager 类
 * @description 管理 Worker 池，负责初始化、任务分发和故障转移
 */

import { logger } from '../../utils/logger.js';
import { registry } from '../registry.js';
import { Worker } from './Worker.js';

/**
 * PoolManager 类 - 管理 Worker 池
 */
export class PoolManager {
    /**
     * @param {object} config - 全局配置
     */
    constructor(config) {
        this.config = config;
        this.workers = [];
        this.strategy = config.backend.pool.strategy || 'least_busy';
        this.initialized = false;
        this.roundRobinIndex = 0;
    }

    /**
     * 初始化所有 Worker
     */
    async initAll() {
        if (this.initialized) return;

        // 先加载所有适配器
        await registry.loadAll();

        // 注入适配器配置（用于模型过滤）
        const adapterConfig = this.config.backend?.adapter || {};
        registry.setAdapterConfig(adapterConfig);

        // 解析登录模式参数
        let loginWorkerName = null;
        const loginArg = process.argv.find(arg => arg.startsWith('-login'));
        const isLoginMode = !!loginArg;
        if (loginArg && loginArg.includes('=')) {
            loginWorkerName = loginArg.split('=')[1];
            logger.info('工作池', `登录模式: 仅初始化 Worker "${loginWorkerName}"`);
        } else if (isLoginMode) {
            loginWorkerName = this.config.backend.pool.workers[0]?.name || null;
            logger.info('工作池', `登录模式: 仅初始化第一个 Worker "${loginWorkerName}"`);
        }

        const workerConfigs = this.config.backend.pool.workers;

        if (isLoginMode) {
            logger.info('工作池', `登录模式: 从 ${workerConfigs.length} 个 Worker 中筛选...`);
        } else {
            logger.info('工作池', `正在初始化 ${workerConfigs.length} 个 Worker...`);
        }

        // 过滤并创建 Worker 实例
        const validWorkers = [];
        for (const workerConfig of workerConfigs) {
            if (isLoginMode && workerConfig.name !== loginWorkerName) {
                logger.debug('工作池', `[${workerConfig.name}] 跳过 (不匹配登录目标)`);
                continue;
            }

            if (workerConfig.type !== 'merge' && !registry.hasAdapter(workerConfig.type)) {
                logger.error('工作池', `Worker [${workerConfig.name}] 的类型 "${workerConfig.type}" 无对应适配器，跳过`);
                continue;
            }

            if (workerConfig.type === 'merge') {
                const invalidTypes = (workerConfig.mergeTypes || []).filter(t => !registry.hasAdapter(t));
                if (invalidTypes.length > 0) {
                    logger.error('工作池', `Worker [${workerConfig.name}] 的 mergeTypes 包含无效类型: ${invalidTypes.join(', ')}`);
                    continue;
                }
            }

            validWorkers.push(new Worker(this.config, workerConfig));
        }

        if (isLoginMode && validWorkers.length === 0) {
            const availableNames = workerConfigs.map(w => w.name).join(', ');
            throw new Error(`登录模式未找到 Worker "${loginWorkerName}"。可用的 Worker: ${availableNames}`);
        }

        // 按 userDataDir 分组
        const browserMap = new Map();

        for (const worker of validWorkers) {
            try {
                const existing = browserMap.get(worker.userDataDir);

                if (existing) {
                    const workerProxy = JSON.stringify(worker.proxyConfig || null);
                    const existingProxy = JSON.stringify(existing.proxyConfig || null);
                    if (workerProxy !== existingProxy) {
                        logger.warn('工作池', `[${worker.name}] 代理配置与 [${existing.firstWorkerName}] 不一致，将使用后者的配置`);
                    }

                    logger.debug('工作池', `[${worker.name}] 将与其他 Worker 共享浏览器 (${worker.userDataDir})`);
                    await worker.init(existing.browser);

                    // 建立共享关系：设置所有者引用，并添加到所有者的共享列表
                    worker._browserOwner = existing.ownerWorker;
                    existing.ownerWorker._sharedWorkers.push(worker);
                } else {
                    await worker.init();
                    browserMap.set(worker.userDataDir, {
                        browser: worker.browser,
                        proxyConfig: worker.proxyConfig,
                        firstWorkerName: worker.name,
                        ownerWorker: worker  // 保存所有者 Worker 引用
                    });
                }

                this.workers.push(worker);
            } catch (e) {
                logger.error('工作池', `[${worker.name}] 初始化失败，跳过该 Worker`, { error: e.message });
            }
        }

        if (this.workers.length === 0) {
            throw new Error('所有 Worker 初始化都失败了，无法启动服务');
        }

        this.initialized = true;
        logger.info('工作池', `工作池初始化完成，共 ${this.workers.length} 个 Worker 就绪 (${browserMap.size} 个浏览器实例)`);
    }

    /**
     * 获取所有模型列表
     */
    getModels() {
        const allModels = [];
        const seenIds = new Set();

        for (const worker of this.workers) {
            const models = worker.getModels();
            for (const m of models) {
                if (!seenIds.has(m.id)) {
                    seenIds.add(m.id);
                    allModels.push(m);
                }
            }
        }

        return { object: 'list', data: allModels };
    }

    /**
     * 获取图片策略（宽松策略：只要有一个 Worker 支持 optional 就返回 optional）
     */
    getImagePolicy(modelKey) {
        const policies = new Set();

        for (const worker of this.workers) {
            if (worker.supports(modelKey)) {
                policies.add(worker.getImagePolicy(modelKey));
            }
        }

        // 宽松策略：只要有一个 optional 就返回 optional
        if (policies.has('optional')) return 'optional';
        if (policies.has('required')) return 'required';
        if (policies.has('forbidden')) return 'forbidden';
        return 'optional';
    }

    /**
     * 获取模型类型
     */
    getModelType(modelKey) {
        for (const worker of this.workers) {
            if (worker.supports(modelKey)) {
                return worker.getModelType(modelKey);
            }
        }
        return 'image';
    }

    /**
     * 获取指定实例的 Cookies
     */
    async getCookies(instanceName, domain) {
        let worker;
        if (instanceName) {
            worker = this.workers.find(w => w.instanceName === instanceName);
            if (!worker) {
                throw new Error(`浏览器实例不存在: ${instanceName}`);
            }
        } else {
            worker = this.workers[0];
            if (!worker) {
                throw new Error('工作池中没有可用的 Worker');
            }
        }

        const cookies = await worker.getCookies(domain);
        return { instance: worker.instanceName, cookies };
    }

    /**
     * 触发所有 merge Worker 的监控导航
     */
    async navigateToMonitor() {
        for (const worker of this.workers) {
            if (worker.type === 'merge' && worker.busyCount === 0) {
                await worker.navigateToMonitor();
            }
        }
    }

    /**
     * 获取第一个 Worker 的 page
     */
    getFirstPage() {
        return this.workers[0]?.page || null;
    }
}
