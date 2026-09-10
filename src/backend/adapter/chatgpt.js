/** Browser initialization metadata. Images use the ordinary explicit website send. */
export const manifest = {
    id: 'chatgpt',
    displayName: 'ChatGPT (图片生成)',
    description: '使用 ChatGPT 官网生成图片，支持参考图片上传。需要已登录的 ChatGPT 账户，请使用会员账号 (包含 K12 教师认证)，非会员账号会有速率限制。',

    // 入口 URL
    getTargetUrl(config, workerConfig) {
        return 'https://chatgpt.com/';
    },

    // 模型列表
    models: [
        { id: 'gpt-image-1.5', imagePolicy: 'optional' }
    ],

    // 无需导航处理器
    navigationHandlers: [],

    controlsOnly: true
};
