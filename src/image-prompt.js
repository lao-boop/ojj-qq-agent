export async function toImagePrompt(llm, prompt, logger, helperModel) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('空提示词');
  const hasCJK = /[\u4e00-\u9fff]/.test(text);
  let english = text;
  if (hasCJK) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await llm.chat({
          messages: [
            {
              role: 'system',
              content:
                'Write a faithful production brief in English. State the subject, its attributes and their relationships together. For worn accessories, describe who wears each item, the body part it wraps around, and a visible point of contact (for example, the band of a neck scarf passes behind the jaw). Respect requested poses and styles. For explicit layout instructions, place each object inside its requested region with its own color and size. Describe any specified background edge to edge. Copy requested lettering verbatim in its original language. Preserve requests for no text. Do not add a mockup, framing, objects or composition constraints that the user did not request. Output only the brief.',
            },
            { role: 'user', content: text },
          ],
          model: helperModel || llm.cfg.visionModel,
          maxTokens: 800,
          directAnswer: true,
          temperature: 0.3,
        });
        const out = (res.content || '').trim().replace(/^["'`]+|["'`]+$/g, '');
        if (out.length >= 8 && /[a-z]{2,}/i.test(out) &&
            (out.match(/[\u4e00-\u9fff]+/g) || []).every(literal => text.includes(literal))) {
          english = out;
          break;
        }
        logger.warn(`提示词翻译结果不合格（第 ${attempt + 1} 次）：${out.slice(0, 40) || '空'}`);
      } catch (err) {
        logger.warn(`提示词翻译失败（第 ${attempt + 1} 次）：${err.message}`);
      }
    }
  }
  return english;
}
