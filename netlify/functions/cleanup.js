exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { rawText } = JSON.parse(event.body);

    if (!rawText || !rawText.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No text provided' })
      };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Server not configured — missing API key' })
      };
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: 'You are a construction field notes editor. Clean up the following voice-dictated walk note from a residential home builder. Fix grammar, punctuation, and organization. Keep it concise and factual. Preserve all specific details (lot numbers, trade names, measurements, observations). Return only the cleaned note text — no preamble, no explanation.\n\nRaw note:\n' + rawText
        }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: data.error.message || 'Anthropic API error' })
      };
    }

    const cleaned = data.content?.map(c => c.text || '').join('').trim();

    return {
      statusCode: 200,
      body: JSON.stringify({ cleaned: cleaned || '' })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.toString() })
    };
  }
};
