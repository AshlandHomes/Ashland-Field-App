const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { rawText, format } = JSON.parse(event.body);
    if (!rawText) return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };

    const client = new Anthropic();

    let prompt;
    if (format === 'bullets') {
      prompt = 'You are a construction field notes editor. Clean up the following voice-dictated walk note from a residential home builder. Format the output as concise bullet points. Each bullet should capture one distinct observation, issue, or action item. Fix grammar and spelling. Preserve all specific details (lot numbers, trade names, measurements, observations). Return only the bullet points — no preamble, no explanation, no markdown code fences.\n\nRaw note:\n' + rawText;
    } else {
      prompt = 'You are a construction field notes editor. Clean up the following voice-dictated walk note from a residential home builder. Fix grammar, punctuation, and organization. Keep it concise and factual. Preserve all specific details (lot numbers, trade names, measurements, observations). Return only the cleaned note text — no preamble, no explanation.\n\nRaw note:\n' + rawText;
    }

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });

    const cleaned = message.content.map(c => c.text || '').join('').trim();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleaned })
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.toString() }) };
  }
};
