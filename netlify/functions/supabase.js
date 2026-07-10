// Netlify serverless function — Supabase data proxy
// Supports both legacy (eyJ) and new (sb_publishable_) key formats


const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

async function supabaseRequest(method, path, body) {
  // Support both old REST API format and new format
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };
  if (method === 'POST' || method === 'PATCH') {
    headers['Prefer'] = 'return=representation';
  }
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  
  const resp = await fetch(url, opts);
  const text = await resp.text();
  
  if (!resp.ok) {
    console.error(`Supabase ${method} ${path} failed:`, resp.status, text);
    return { status: resp.status, data: null, error: text };
  }
  
  try { 
    return { status: resp.status, data: JSON.parse(text) }; 
  } catch(e) { 
    return { status: resp.status, data: text }; 
  }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: 'Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables' }) 
    };
  }
// Shared-secret gate — rejects any caller without the secret header
  const SHARED_SECRET = process.env.API_SHARED_SECRET;
  if (SHARED_SECRET) {
    const provided = event.headers['x-api-secret'] || event.headers['X-Api-Secret'];
    if (provided !== SHARED_SECRET) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }
  try {
    const { action, payload } = JSON.parse(event.body);

    switch(action) {

      case 'getLots': {
        const r = await supabaseRequest('GET', 'field_ops_lots?select=*&order=subdivision,number');
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'upsertLot': {
        const r = await supabaseRequest('POST', 'field_ops_lots?on_conflict=id', {
          ...payload,
          updated_at: new Date().toISOString()
        });
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'upsertLots': {
        const r = await supabaseRequest('POST', 'field_ops_lots?on_conflict=id', payload);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'updateLot': {
        const { id, ...updates } = payload;
        const r = await supabaseRequest(
          'PATCH',
          `field_ops_lots?id=eq.${id}`,
          { ...updates, updated_at: new Date().toISOString() }
        );
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'deleteLot': {
        await supabaseRequest('DELETE', `field_ops_lots?id=eq.${payload.id}`);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'addSubmission': {
        const r = await supabaseRequest('POST', 'field_ops_submissions', payload);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'getSubmissions': {
        const r = await supabaseRequest('GET', 'field_ops_submissions?select=*&order=submitted_at.desc&limit=500');
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'addWalkNote': {
        const r = await supabaseRequest('POST', 'field_ops_walk_notes', payload);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'getWalkNotes': {
        const r = await supabaseRequest('GET', `field_ops_walk_notes?lot_id=eq.${payload.lotId}&select=*&order=created_at.asc`);
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'deleteWalkNote': {
        await supabaseRequest('DELETE', `field_ops_walk_notes?id=eq.${payload.id}`);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'getBuilders': {
        const r = await supabaseRequest('GET', 'field_ops_builders?select=*&order=name');
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'updateBuilderPin': {
        const { name, pin_hash, temp_pin, subdivisions } = payload;
        const updates = { updated_at: new Date().toISOString() };
        if (pin_hash !== undefined) updates.pin_hash = pin_hash;
        if (temp_pin !== undefined) updates.temp_pin = temp_pin;
        if (subdivisions !== undefined) updates.subdivisions = subdivisions;
        const r = await supabaseRequest('PATCH', `field_ops_builders?name=eq.${encodeURIComponent(name)}`, updates);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'verifyPin': {
        const { name, pin } = payload;
        const r = await supabaseRequest('GET', `field_ops_builders?name=eq.${encodeURIComponent(name)}&select=pin_hash,temp_pin,is_admin`);
        if (!r.data || !r.data.length) {
          return { statusCode: 200, body: JSON.stringify({ valid: false, reason: 'builder_not_found' }) };
        }
        const builder = r.data[0];
        if (builder.temp_pin && builder.temp_pin === pin) {
          return { statusCode: 200, body: JSON.stringify({ valid: true, is_temp: true }) };
        }
        if (builder.pin_hash && builder.pin_hash === pin) {
          return { statusCode: 200, body: JSON.stringify({ valid: true, is_temp: false }) };
        }
        return { statusCode: 200, body: JSON.stringify({ valid: false, reason: 'wrong_pin' }) };
      }

      case 'addOverride': {
        const r = await supabaseRequest('POST', 'field_ops_overrides', payload);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'getOverrides': {
        const r = await supabaseRequest('GET', 'field_ops_overrides?select=*&order=overridden_at.desc&limit=500');
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'resetWeek': {
        await supabaseRequest('PATCH', 'field_ops_lots?updated_this_week=eq.true', { 
          updated_this_week: false, 
          updated_at: new Date().toISOString() 
        });
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'ping': {
        // Test connection
        const r = await supabaseRequest('GET', 'field_ops_lots?select=count&limit=1');
        return { statusCode: 200, body: JSON.stringify({ ok: true, status: r.status }) };
      }

      case 'deleteBuilder': {
        await supabaseRequest('DELETE', `field_ops_builders?name=eq.${encodeURIComponent(payload.name)}`);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'upsertBuilderRecord': {
        const r = await supabaseRequest('POST', 'field_ops_builders?on_conflict=name', {
          ...payload,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'addDelay': {
        const r = await supabaseRequest('POST', 'field_ops_delays', payload);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'getDelays': {
        const lotFilter = payload && payload.lotId ? `?lot_id=eq.${payload.lotId}&` : '?';
        const r = await supabaseRequest('GET', `field_ops_delays${lotFilter}select=*&order=created_at.desc&limit=200`);
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'addTaskNote': {
        const r = await supabaseRequest('POST', 'field_ops_task_notes', payload);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'getTaskNotes': {
        const r = await supabaseRequest('GET', `field_ops_task_notes?lot_id=eq.${payload.lotId}&select=*&order=created_at.asc`);
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
    }

  } catch(err) {
    console.error('Handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.toString() }) };
  }
};

// Note: upsertBuilderRecord added at end
