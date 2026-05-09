/**
 * @fileoverview IPC 通信模块
 * @description 提供与 Supervisor 进程通信的能力
 */

import net from 'net';

/**
 * 发送重启信号给 Supervisor
 * @param {string[]} [extraArgs] - 额外的命令行参数
 * @returns {Promise<boolean>} 是否成功发送
 */
export async function sendRestartSignal(extraArgs = []) {
    const ipcPath = process.env.SUPERVISOR_IPC;

    if (!ipcPath) {
        console.warn('[IPC] 未运行在 Supervisor 模式下，无法发送重启信号');
        return false;
    }

    return new Promise((resolve) => {
        const client = net.createConnection(ipcPath, () => {
            // 格式: RESTART 或 RESTART:arg1 arg2
            const command = extraArgs.length > 0
                ? `RESTART:${extraArgs.join(' ')}`
                : 'RESTART';
            client.write(command);
            client.end();
            resolve(true);
        });

        client.on('error', (err) => {
            console.error('[IPC] 连接 Supervisor 失败:', err.message);
            resolve(false);
        });
    });
}

/**
 * 发送停止信号给 Supervisor
 * @returns {Promise<boolean>} 是否成功发送
 */
export async function sendStopSignal() {
    const ipcPath = process.env.SUPERVISOR_IPC;

    if (!ipcPath) {
        console.warn('[IPC] 未运行在 Supervisor 模式下，无法发送停止信号');
        return false;
    }

    return new Promise((resolve) => {
        const client = net.createConnection(ipcPath, () => {
            client.write('STOP');
            client.end();
            resolve(true);
        });

        client.on('error', (err) => {
            console.error('[IPC] 连接 Supervisor 失败:', err.message);
            resolve(false);
        });
    });
}

/**
 * 检查是否运行在 Supervisor 模式下
 * @returns {boolean}
 */
export function isUnderSupervisor() {
    return !!process.env.SUPERVISOR_IPC;
}

/**
 * 获取 VNC 状态信息
 * @returns {Promise<{enabled: boolean, port: number, display: string, xvfbMode: boolean} | null>}
 */
export async function getVncInfo() {
    const ipcPath = process.env.SUPERVISOR_IPC;

    if (!ipcPath) {
        return null;
    }

    return new Promise((resolve) => {
        const client = net.createConnection(ipcPath, () => {
            client.write('GET_VNC_INFO');
        });

        let data = '';
        client.on('data', (chunk) => {
            data += chunk.toString();
        });

        client.on('end', () => {
            try {
                const info = JSON.parse(data.trim());
                resolve(info);
            } catch {
                resolve(null);
            }
        });

        client.on('error', () => {
            resolve(null);
        });

        // 超时处理
        setTimeout(() => {
            client.destroy();
            resolve(null);
        }, 3000);
    });
}
