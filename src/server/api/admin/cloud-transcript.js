/**
 * Map ChatGPT's cloud conversation graph to the visible transcript.
 *
 * Self-contained on purpose: routes.js stringifies this function and runs it
 * inside the ChatGPT browser page, so it must not reference module scope.
 * Image replies (image_gen / dalle) arrive as multimodal_text or
 * image_asset_pointer parts with an asset_pointer and no text; they are kept
 * as assistant turns with an images[] list instead of being dropped.
 */
export function mapConversationMessages(nodeMap) {
    const messages = [];
    const hidden = ['analysis', 'thinking'];
    const fileIdFromPointer = (pointer) => {
        const m = /^[a-z-]+:\/\/(.+)$/i.exec(String(pointer || ''));
        return m ? m[1].split('?')[0] : null;
    };
    for (const node of Object.values(nodeMap || {})) {
        const msg = node && node.message;
        if (!msg || !msg.content) continue;
        const role = msg.author && msg.author.role;
        const content = msg.content;
        const parts = Array.isArray(content.parts) ? content.parts : [];
        const images = [];
        const pushImage = (p) => {
            const fileId = fileIdFromPointer(p && p.asset_pointer);
            if (!fileId) return;
            images.push({ asset_pointer: p.asset_pointer, file_id: fileId, width: p.width || null, height: p.height || null });
        };
        if (content.content_type === 'image_asset_pointer') pushImage(content);
        for (const part of parts) if (part && typeof part === 'object' && part.asset_pointer) pushImage(part);
        const isImageTool = role === 'tool' && images.length > 0;
        if (role !== 'user' && role !== 'assistant' && !isImageTool) continue;
        if (role === 'assistant' && hidden.includes(msg.channel)) continue;
        const ct = content.content_type;
        if (ct !== 'text' && ct !== 'multimodal_text' && ct !== 'image_asset_pointer') continue;
        const text = parts.map(part => typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : '')).join('');
        if (!text.trim() && images.length === 0) continue;
        messages.push({ id: msg.id, role: isImageTool ? 'assistant' : role, text, images, model: msg.model || null, create_time: msg.create_time });
    }
    messages.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
    return messages;
}
