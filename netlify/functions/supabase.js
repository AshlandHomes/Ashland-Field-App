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
        const r = await supabaseRequest('GET', 'field_ops_lots?select=count&limit=1');
        return { statusCode: 200, body: JSON.stringify({ ok: true, status: r.status, error: r.error || null, url: SUPABASE_URL }) };
      }
case 'keycheck': {
        return { statusCode: 200, body: JSON.stringify({
          keyStart: (SUPABASE_KEY || 'NONE').slice(0, 12),
          hasServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
          hasAnon: !!process.env.SUPABASE_ANON_KEY
        }) };
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
// ══════════════════════════════════════════════════════
      // SCHEDULE ENGINE — template + lot stamping (Step 2a)
      // ══════════════════════════════════════════════════════

      case 'getTemplates': {
        const r = await supabaseRequest('GET', 'sched_templates?select=id,name,description,status,total_days&order=name');
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'getScheduleLots': {
        const r = await supabaseRequest('GET', 'sched_lots?select=*&order=created_at.desc');
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'deleteScheduleLot': {
        await supabaseRequest('DELETE', `sched_lots?id=eq.${payload.id}`);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'stampLot': {
        const { template_id, lot_number, address, community, builder_id } = payload;
        if (!template_id || !lot_number) {
          return { statusCode: 400, body: JSON.stringify({ error: 'template_id and lot_number are required' }) };
        }

        const phRes = await supabaseRequest('GET', `sched_template_phases?template_id=eq.${template_id}&select=id,name,phase_order`);
        const phases = phRes.data || [];
        const phaseMap = {};
        phases.forEach(p => { phaseMap[p.id] = { name: p.name, order: p.phase_order }; });

        const tkRes = await supabaseRequest('GET', `sched_template_tasks?template_id=eq.${template_id}&select=*&order=task_order`);
        const tasks = tkRes.data || [];
        if (!tasks.length) {
          return { statusCode: 400, body: JSON.stringify({ error: 'Template has no tasks — nothing to stamp' }) };
        }

        const lotRes = await supabaseRequest('POST', 'sched_lots', {
          template_id,
          lot_number,
          address: address || null,
          community: community || null,
          builder_id: builder_id || null,
          status: 'active'
        });
        if (lotRes.error || !lotRes.data) {
          return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create lot: ' + (lotRes.error || 'unknown') }) };
        }
        const lot = Array.isArray(lotRes.data) ? lotRes.data[0] : lotRes.data;
        const lot_id = lot.id;

        const lotTasks = tasks.map(t => {
          const ph = phaseMap[t.phase_id] || {};
          return {
            lot_id,
            source_task_id: t.id,
            bt_num: t.bt_num,
            name: t.name,
            phase_name: ph.name || null,
            phase_order: (ph.order !== undefined ? ph.order : null),
            duration: t.duration,
            lag: t.lag,
            relative_start: t.relative_start,
            predecessors: t.predecessors,
            notification: t.notification,
            relative_finish: t.relative_finish,
            is_critical: t.is_critical,
            task_type: t.task_type || 'work',
            task_order: t.task_order,
            status: 'not_started'
          };
        });
        const insTasks = await supabaseRequest('POST', 'sched_lot_tasks', lotTasks);
        if (insTasks.error) {
          await supabaseRequest('DELETE', `sched_lots?id=eq.${lot_id}`);
          return { statusCode: 500, body: JSON.stringify({ error: 'Failed to copy tasks: ' + insTasks.error }) };
        }

        const gRes = await supabaseRequest('GET', `sched_template_gates?template_id=eq.${template_id}&select=*`);
        const gates = gRes.data || [];
        if (gates.length) {
          const gateRows = gates.map(g => ({
            lot_id,
            source_gate_id: g.id,
            gate_name: g.name,
            confirmed: false
          }));
          await supabaseRequest('POST', 'sched_lot_gate_state', gateRows);
        }

        return { statusCode: 200, body: JSON.stringify({ success: true, lot_id, task_count: lotTasks.length, gate_count: gates.length }) };
      }
        case 'updateScheduleLot': {
        const { id, ...updates } = payload;
        if (!id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'id is required' }) };
        }
        updates.updated_at = new Date().toISOString();
        const r = await supabaseRequest('PATCH', `sched_lots?id=eq.${id}`, updates);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }
        case 'getScheduleLotTasks': {
        const { lot_id } = payload;
        if (!lot_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'lot_id is required' }) };
        }
        const t = await supabaseRequest('GET', `sched_lot_tasks?lot_id=eq.${lot_id}&select=*&order=task_order`);
        const g = await supabaseRequest('GET', `sched_lot_gate_state?lot_id=eq.${lot_id}&select=*`);
        return { statusCode: 200, body: JSON.stringify({ tasks: t.data || [], gates: g.data || [] }) };
      }
        case 'updateScheduleLotTask': {
        const { task_id, lot_id, status, actual_start, actual_finish } = payload;
        if (!task_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'task_id is required' }) };
        }
        const updates = { updated_at: new Date().toISOString() };
        if (status !== undefined) updates.status = status;
        if (actual_start !== undefined) updates.actual_start = actual_start;
        if (actual_finish !== undefined) updates.actual_finish = actual_finish;
        const r = await supabaseRequest('PATCH', `sched_lot_tasks?id=eq.${task_id}`, updates);
        if (lot_id) {
          await supabaseRequest('PATCH', `sched_lots?id=eq.${lot_id}`, { last_task_update: new Date().toISOString() });
        }
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }
        case 'getTemplateStageMap': {
        const { template_id } = payload;
        if (!template_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'template_id is required' }) };
        }
        const smRes = await supabaseRequest('GET', `sched_template_stage_map?template_id=eq.${template_id}&select=id,stage_code,stage_label,is_manual,stage_order&order=stage_order`);
        const sm = smRes.data || [];
        const tkRes = await supabaseRequest('GET', `sched_template_tasks?template_id=eq.${template_id}&select=id,bt_num`);
        const btById = {};
        (tkRes.data || []).forEach(t => { btById[t.id] = t.bt_num; });
        const smIds = sm.map(s => s.id);
        let joins = [];
        if (smIds.length) {
          const jRes = await supabaseRequest('GET', `sched_stage_map_tasks?stage_map_id=in.(${smIds.join(',')})&select=stage_map_id,task_id`);
          joins = jRes.data || [];
        }
        const trig = {};
        joins.forEach(j => { (trig[j.stage_map_id] = trig[j.stage_map_id] || []).push(btById[j.task_id]); });
        const stages = sm.map(s => ({
          code: s.stage_code, label: s.stage_label, is_manual: s.is_manual, order: s.stage_order,
          triggers: (trig[s.id] || []).filter(x => x != null)
        }));
        const gRes = await supabaseRequest('GET', `sched_template_gates?template_id=eq.${template_id}&select=name,icon,hold_stage_code,gate_order&order=gate_order`);
        return { statusCode: 200, body: JSON.stringify({ stages, gates: gRes.data || [] }) };
      }

      case 'updateScheduleLotGate': {
        const { gate_id, confirmed } = payload;
        if (!gate_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'gate_id is required' }) };
        }
        const updates = { confirmed: !!confirmed, confirmed_at: confirmed ? new Date().toISOString() : null };
        const r = await supabaseRequest('PATCH', `sched_lot_gate_state?id=eq.${gate_id}`, updates);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }
        case 'updateScheduleLotTaskNote': {
        const { task_id, note, flag } = payload;
        if (!task_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'task_id is required' }) };
        }
        const updates = { updated_at: new Date().toISOString() };
        if (note !== undefined) updates.note = note;
        if (flag !== undefined) updates.flag = flag;
        const r = await supabaseRequest('PATCH', `sched_lot_tasks?id=eq.${task_id}`, updates);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }
        case 'addTaskNote': {
        const { lot_task_id, lot_id, bt_num, note, flag, author } = payload;
        if (!lot_task_id || !note) {
          return { statusCode: 400, body: JSON.stringify({ error: 'lot_task_id and note are required' }) };
        }
        const r = await supabaseRequest('POST', 'sched_lot_task_notes', {
          lot_task_id, lot_id: lot_id || null, bt_num: (bt_num != null ? bt_num : null),
          note, flag: flag || 'none', author: author || null
        });
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'getTaskNotes': {
        const { lot_id } = payload;
        if (!lot_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'lot_id is required' }) };
        }
        const r = await supabaseRequest('GET', `sched_lot_task_notes?lot_id=eq.${lot_id}&select=*&order=created_at.asc`);
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'updateTaskNote': {
        const { id, note, flag } = payload;
        if (!id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'id is required' }) };
        }
        const updates = {};
        if (note !== undefined) updates.note = note;
        if (flag !== undefined) updates.flag = flag;
        const r = await supabaseRequest('PATCH', `sched_lot_task_notes?id=eq.${id}`, updates);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'deleteTaskNote': {
        if (!payload.id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'id is required' }) };
        }
        await supabaseRequest('DELETE', `sched_lot_task_notes?id=eq.${payload.id}`);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }
        case 'getFlaggedNotes': {
        // all red/yellow flagged notes across every lot, newest first, with lot context
        const notes = await supabaseRequest('GET', `sched_lot_task_notes?flag=in.(red,yellow)&select=*&order=created_at.desc`);
        const rows = notes.data || [];
        // attach lot number/community/builder for each note's lot
        const lotIds = [...new Set(rows.map(n => n.lot_id).filter(Boolean))];
        let lotMap = {};
        if (lotIds.length) {
          const lots = await supabaseRequest('GET', `sched_lots?id=in.(${lotIds.join(',')})&select=id,lot_number,community,builder_name`);
          (lots.data || []).forEach(l => { lotMap[l.id] = l; });
        }
        const enriched = rows.map(n => ({
          ...n,
          lot_number: lotMap[n.lot_id] ? lotMap[n.lot_id].lot_number : null,
          community: lotMap[n.lot_id] ? lotMap[n.lot_id].community : null,
          builder_name: lotMap[n.lot_id] ? lotMap[n.lot_id].builder_name : null
        }));
        return { statusCode: 200, body: JSON.stringify(enriched) };
      }
        case 'debugNotes': {
        const r = await supabaseRequest('GET', 'sched_lot_task_notes?select=*&limit=5');
        return { statusCode: 200, body: JSON.stringify({ status: r.status, error: r.error || null, data: r.data }) };
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
