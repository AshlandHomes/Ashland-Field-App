exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { rawText } = JSON.parse(event.body);
    if (!rawText) return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };

    const prompt = 'You are a construction field notes editor. Clean up the following voice-dictated walk note from a residential home builder. Format using bold section headers (e.g. **Electrical**, **Plumbing**, **Action Items**) followed by bullet points using a dash (-). Every piece of content must be a bullet point under a header — never write prose paragraphs. Each bullet should capture one distinct observation, issue, or action item. Fix grammar and spelling. Preserve all specific details (lot numbers, trade names, measurements, inspection results). Return only the formatted note — no preamble, no explanation.\n\nRaw note:\n' + rawText;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await resp.json();
    if (data.error) return { statusCode: 500, body: JSON.stringify({ error: data.error.message }) };

    const cleaned = data.content.map(c => c.text || '').join('').trim();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleaned })
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.toString() }) };
  }
};
