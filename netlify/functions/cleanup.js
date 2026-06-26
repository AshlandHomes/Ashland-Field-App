exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { rawText } = JSON.parse(event.body);
    if (!rawText) return { statusCode: 400, body: JSON.stringify({ error: 'No text provided' }) };

    const prompt = `You are a construction field notes editor. Transform the following raw voice-dictated note into structured CliffNotes format.

STRICT FORMAT RULES — follow exactly:
1. Use 1-4 bold headers depending on content (e.g. **Electrical Issue**, **Resolution**, **Action Items**, **Observations**)
2. Under EVERY header, write bullet points only — start each with a dash (-)
3. NEVER write sentences or paragraphs — only bullets
4. Each bullet = one clear fact, problem, observation, or action
5. Compress and condense — remove filler words, shorten without losing meaning
6. Fix spelling/grammar, keep all specific details (names, measurements, trades, lot numbers)
7. Output ONLY the formatted result — nothing else

Example output format:
**Framing Issue**
- Header beam missing at garage opening
- Framer was not on site

**Action Items**
- Framer to return Thursday
- Inspector notified — reinspection needed Friday

Now format this note:
${rawText}`;

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
