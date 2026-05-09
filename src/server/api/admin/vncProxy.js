/**
 * @fileoverview VNC WebSocket 代理模块
 * @description 将 VNC TCP 连接转发到 WebSocket
 */

import net from 'net';
import { getVncInfo } from '../../../utils/ipc.js';

/**
 * 处理 VNC WebSocket 升级请求
 * @param {import('http').IncomingMessage} req - HTTP 请求
 * @param {import('net').Socket} socket - 原始 TCP socket
 * @param {Buffer} head - 升级请求的头部数据
 * @param {string} authToken - 有效的认证令牌
 */
export async function handleVncUpgrade(req, socket, head, authToken) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 验证 token
    const token = url.searchParams.get('token');
    if (token !== authToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    // 获取 VNC 信息
    const vncInfo = await getVncInfo();
    if (!vncInfo || !vncInfo.enabled) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
    }

    // 手动完成 WebSocket 握手
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    const crypto = await import('crypto');
    const acceptKey = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

    // 发送 WebSocket 握手响应
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        'Sec-WebSocket-Protocol: binary\r\n' +
        '\r\n'
    );

    // 连接到 VNC 服务器
    const vncSocket = net.createConnection({
        host: '127.0.0.1',
        port: vncInfo.port
    });

    vncSocket.on('error', (err) => {
        console.error('[VNC Proxy] VNC 连接错误:', err.message);
        socket.destroy();
    });

    vncSocket.on('connect', () => {
        // 发送升级请求时可能附带的数据
        if (head && head.length > 0) {
            const data = decodeWebSocketFrame(head);
            if (data) vncSocket.write(data);
        }
    });

    // VNC -> WebSocket
    vncSocket.on('data', (data) => {
        try {
            const frame = encodeWebSocketFrame(data);
            socket.write(frame);
        } catch {
            socket.destroy();
        }
    });

    // WebSocket -> VNC
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= 2) {
            const result = decodeWebSocketFrame(buffer);
            if (!result) break;

            const { data, bytesConsumed, opcode } = result;

            // 关闭帧
            if (opcode === 0x08) {
                vncSocket.destroy();
                socket.destroy();
                return;
            }

            // 二进制数据或文本
            if (data && data.length > 0) {
                vncSocket.write(data);
            }

            buffer = buffer.slice(bytesConsumed);
        }
    });

    socket.on('close', () => vncSocket.destroy());
    socket.on('error', () => vncSocket.destroy());
    vncSocket.on('close', () => socket.destroy());
}

/**
 * 编码 WebSocket 帧（服务端发送，无掩码）
 * @param {Buffer} data - 要发送的数据
 * @returns {Buffer} WebSocket 帧
 */
function encodeWebSocketFrame(data) {
    const length = data.length;
    let header;

    if (length <= 125) {
        header = Buffer.alloc(2);
        header[0] = 0x82; // FIN + Binary
        header[1] = length;
    } else if (length <= 65535) {
        header = Buffer.alloc(4);
        header[0] = 0x82;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x82;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }

    return Buffer.concat([header, data]);
}

/**
 * 解码 WebSocket 帧（客户端发送，有掩码）
 * @param {Buffer} buffer - 接收到的数据
 * @returns {{data: Buffer, bytesConsumed: number, opcode: number} | null}
 */
function decodeWebSocketFrame(buffer) {
    if (buffer.length < 2) return null;

    const firstByte = buffer[0];
    const secondByte = buffer[1];
    const opcode = firstByte & 0x0F;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let offset = 2;

    if (payloadLength === 126) {
        if (buffer.length < 4) return null;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
    } else if (payloadLength === 127) {
        if (buffer.length < 10) return null;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
    }

    let maskKey = null;
    if (masked) {
        if (buffer.length < offset + 4) return null;
        maskKey = buffer.slice(offset, offset + 4);
        offset += 4;
    }

    if (buffer.length < offset + payloadLength) return null;

    let data = buffer.slice(offset, offset + payloadLength);

    if (masked && maskKey) {
        data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) {
            data[i] ^= maskKey[i % 4];
        }
    }

    return {
        data,
        bytesConsumed: offset + payloadLength,
        opcode
    };
}
