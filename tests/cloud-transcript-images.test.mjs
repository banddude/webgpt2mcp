import assert from 'node:assert/strict';
import test from 'node:test';
import { mapConversationMessages } from '../src/server/api/admin/cloud-transcript.js';

const mapping = {
    a: { message: { id: 'a', author: { role: 'user' }, create_time: 1, content: { content_type: 'text', parts: ['make an image'] } } },
    b: { message: { id: 'b', author: { role: 'assistant' }, channel: 'analysis', create_time: 2, content: { content_type: 'text', parts: ['thinking...'] } } },
    c: { message: { id: 'c', author: { role: 'assistant' }, create_time: 3, model: 'gpt-instant', content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_00000000abc', width: 1024, height: 1024 }] } } },
    d: { message: { id: 'd', author: { role: 'tool', name: 'dalle.text2im' }, create_time: 4, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-XYZ' }] } } },
    e: { message: { id: 'e', author: { role: 'tool' }, create_time: 5, content: { content_type: 'code', parts: ['print(1)'] } } },
    f: { message: { id: 'f', author: { role: 'assistant' }, create_time: 6, content: { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_TOP', width: 512, height: 512 } } },
};

test('image-only assistant and image-tool turns are kept as assistant turns with file ids', () => {
    const out = mapConversationMessages(mapping);
    assert.deepEqual(out.map(m => m.id), ['a', 'c', 'd', 'f']);
    assert.equal(out[1].role, 'assistant');
    assert.equal(out[1].text, '');
    assert.deepEqual(out[1].images, [{ asset_pointer: 'sediment://file_00000000abc', file_id: 'file_00000000abc', width: 1024, height: 1024 }]);
    assert.equal(out[2].role, 'assistant', 'image tool turn is surfaced as the assistant reply');
    assert.equal(out[2].images[0].file_id, 'file-XYZ');
    assert.equal(out[3].images[0].file_id, 'file_TOP');
});

test('mapper is self-contained so routes.js can inject it into the ChatGPT page', () => {
    const injected = new Function(`return (${mapConversationMessages.toString()})`)();
    assert.equal(injected(mapping).length, 4);
});
