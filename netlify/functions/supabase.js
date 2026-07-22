// Netlify serverless function — Supabase data proxy
// Supports both legacy (eyJ) and new (sb_publishable_) key formats


const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const TABLE_PREFIX = process.env.TABLE_PREFIX || '';

async function supabaseRequest(method, path, body) {
  const _m = path.match(/^([a-zA-Z0-9_]+)(.*)$/);
  const _path = _m ? (TABLE_PREFIX + _m[1] + _m[2]) : path;
  const url = `${SUPABASE_URL}/rest/v1/${_path}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };
  if (method === 'POST' || method === 'PATCH') {
    headers['Prefer'] = 'return=representation';
  }
  // PostgREST caps results at 1000 rows by default, and that server cap overrides
  // any &limit= in the URL. A Range header DOES lift the cap. If a GET asks for a
  // large limit, translate it into a Range so big result sets aren't truncated.
  if (method === 'GET') {
    const lm = /[?&]limit=(\d+)/.exec(path);
    if (lm && parseInt(lm[1]) > 1000) {
      headers['Range-Unit'] = 'items';
      headers['Range'] = '0-' + (parseInt(lm[1]) - 1);
    }
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

      case 'verifyAdminPin': {
        const { pin } = payload;
        const envPin = (process.env.ADMIN_PIN || '').trim();
        const valid = !!pin && pin.trim() === envPin;
        return { statusCode: 200, body: JSON.stringify({ valid }) };
      }

      case 'verifyPin': {
        const { name, pin } = payload;
        const r = await supabaseRequest('GET', `field_ops_builders?name=eq.${encodeURIComponent(name)}&select=pin_hash,temp_pin,is_admin,failed_attempts,is_locked`);
        if (!r.data || !r.data.length) {
          return { statusCode: 200, body: JSON.stringify({ valid: false, reason: 'builder_not_found' }) };
        }
        const b = r.data[0];
        if (b.is_locked) {
          return { statusCode: 200, body: JSON.stringify({ valid: false, locked: true, reason: 'locked' }) };
        }
        const ok = (b.temp_pin && b.temp_pin === pin) || (b.pin_hash && b.pin_hash === pin);
        if (ok) {
          await supabaseRequest('PATCH', `field_ops_builders?name=eq.${encodeURIComponent(name)}`, { failed_attempts: 0, updated_at: new Date().toISOString() });
          const isTemp = !!(b.temp_pin && b.temp_pin === pin);
          return { statusCode: 200, body: JSON.stringify({ valid: true, is_temp: isTemp }) };
        }
        const attempts = (b.failed_attempts || 0) + 1;
        const lock = attempts >= 5;
        await supabaseRequest('PATCH', `field_ops_builders?name=eq.${encodeURIComponent(name)}`, { failed_attempts: attempts, is_locked: lock, updated_at: new Date().toISOString() });
        return { statusCode: 200, body: JSON.stringify({ valid: false, reason: 'wrong_pin', locked: lock, attemptsLeft: Math.max(0, 5 - attempts) }) };
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

      // ══════════════════════════════════════════════════════
      // SCHEDULE ENGINE — template + lot stamping
      // ══════════════════════════════════════════════════════

      // ══════════════════════════════════════════════════════
      // SCHEDULE TEMPLATE BUILDER
      // ══════════════════════════════════════════════════════

      case 'createTemplate': {
        const { name, description, total_days } = payload;
        if (!name) return { statusCode: 400, body: JSON.stringify({ error: 'name is required' }) };
        const r = await supabaseRequest('POST', 'sched_templates', {
          name,
          description: description || null,
          total_days: total_days != null ? total_days : null,
          status: 'active'
        });
        const row = Array.isArray(r.data) ? r.data[0] : r.data;
        return { statusCode: 200, body: JSON.stringify(row || null) };
      }

      case 'updateTemplate': {
        const { id, ...updates } = payload;
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required' }) };
        const r = await supabaseRequest('PATCH', `sched_templates?id=eq.${id}`, updates);
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'deleteTemplate': {
        // Refuse if any lot was stamped from this template — history must stay intact.
        const { id } = payload;
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required' }) };
        const used = await supabaseRequest('GET', `sched_lots?template_id=eq.${id}&select=id&limit=1`);
        if ((used.data || []).length) {
          return { statusCode: 200, body: JSON.stringify({ error: 'This template is in use by existing lots. Archive it instead.' }) };
        }
        // PostgREST has no subqueries — fetch the stage-map ids, then delete their joins.
        const smDel = await supabaseRequest('GET', `sched_template_stage_map?template_id=eq.${id}&select=id`);
        const smDelIds = (smDel.data || []).map(s => s.id);
        if (smDelIds.length) {
          await supabaseRequest('DELETE', `sched_stage_map_tasks?stage_map_id=in.(${smDelIds.join(',')})`);
        }
        await supabaseRequest('DELETE', `sched_template_stage_map?template_id=eq.${id}`);
        await supabaseRequest('DELETE', `sched_template_gates?template_id=eq.${id}`);
        await supabaseRequest('DELETE', `sched_template_tasks?template_id=eq.${id}`);
        await supabaseRequest('DELETE', `sched_template_phases?template_id=eq.${id}`);
        await supabaseRequest('DELETE', `sched_templates?id=eq.${id}`);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'cloneTemplate': {
        // Deep copy: template + phases + tasks + gates + stage map + trigger joins.
        // IDs are remapped so the copy is fully independent of the source.
        const { source_id, name } = payload;
        if (!source_id || !name) {
          return { statusCode: 400, body: JSON.stringify({ error: 'source_id and name are required' }) };
        }
        const srcRes = await supabaseRequest('GET', `sched_templates?id=eq.${source_id}&select=*`);
        const src = (srcRes.data || [])[0];
        if (!src) return { statusCode: 400, body: JSON.stringify({ error: 'Source template not found' }) };

        const tRes = await supabaseRequest('POST', 'sched_templates', {
          name,
          description: src.description || null,
          total_days: src.total_days != null ? src.total_days : null,
          status: 'active'
        });
        const newT = Array.isArray(tRes.data) ? tRes.data[0] : tRes.data;
        if (!newT || !newT.id) {
          return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create template copy' }) };
        }
        const newId = newT.id;

        // phases
        const phRes = await supabaseRequest('GET', `sched_template_phases?template_id=eq.${source_id}&select=*&order=phase_order`);
        const phases = phRes.data || [];
        const phaseMap = {};
        if (phases.length) {
          const rows = phases.map(p => ({ template_id: newId, name: p.name, phase_order: p.phase_order }));
          const ins = await supabaseRequest('POST', 'sched_template_phases', rows);
          const made = ins.data || [];
          // match by phase_order (unique within a template)
          phases.forEach(p => {
            const hit = made.find(m => m.phase_order === p.phase_order);
            if (hit) phaseMap[p.id] = hit.id;
          });
        }

        // tasks
        const tkRes = await supabaseRequest('GET', `sched_template_tasks?template_id=eq.${source_id}&select=*&order=task_order`);
        const tasks = tkRes.data || [];
        const taskMap = {};
        if (tasks.length) {
          const rows = tasks.map(t => ({
            template_id: newId, bt_num: t.bt_num, name: t.name,
            phase_id: phaseMap[t.phase_id] || null,
            duration: t.duration, lag: t.lag, relative_start: t.relative_start,
            predecessors: t.predecessors, notification: t.notification,
            relative_finish: t.relative_finish, is_critical: t.is_critical,
            task_type: t.task_type || 'work', task_order: t.task_order
          }));
          const ins = await supabaseRequest('POST', 'sched_template_tasks', rows);
          const made = ins.data || [];
          tasks.forEach(t => {
            const hit = made.find(m => m.bt_num === t.bt_num);
            if (hit) taskMap[t.id] = hit.id;
          });
        }

        // gates
        const gRes = await supabaseRequest('GET', `sched_template_gates?template_id=eq.${source_id}&select=*&order=gate_order`);
        const gates = gRes.data || [];
        if (gates.length) {
          await supabaseRequest('POST', 'sched_template_gates', gates.map(g => ({
            template_id: newId, name: g.name, icon: g.icon,
            hold_stage_code: g.hold_stage_code, gate_order: g.gate_order
          })));
        }

        // stage map
        const smRes = await supabaseRequest('GET', `sched_template_stage_map?template_id=eq.${source_id}&select=*&order=stage_order`);
        const sm = smRes.data || [];
        const smMap = {};
        if (sm.length) {
          const rows = sm.map(s => ({
            template_id: newId, stage_code: s.stage_code, stage_label: s.stage_label,
            is_manual: s.is_manual, stage_order: s.stage_order
          }));
          const ins = await supabaseRequest('POST', 'sched_template_stage_map', rows);
          const made = ins.data || [];
          sm.forEach(s => {
            const hit = made.find(m => m.stage_code === s.stage_code);
            if (hit) smMap[s.id] = hit.id;
          });
          // trigger joins
          const smIds = sm.map(s => s.id);
          if (smIds.length) {
            const jRes = await supabaseRequest('GET', `sched_stage_map_tasks?stage_map_id=in.(${smIds.join(',')})&select=*`);
            const joins = (jRes.data || [])
              .filter(j => smMap[j.stage_map_id] && taskMap[j.task_id])
              .map(j => ({ stage_map_id: smMap[j.stage_map_id], task_id: taskMap[j.task_id] }));
            if (joins.length) await supabaseRequest('POST', 'sched_stage_map_tasks', joins);
          }
        }

        return { statusCode: 200, body: JSON.stringify({
          success: true, id: newId, name,
          phases: phases.length, tasks: tasks.length, gates: gates.length, stages: sm.length
        }) };
      }

      case 'getTemplateDetail': {
        // counts for the template list
        const { template_id } = payload;
        if (!template_id) return { statusCode: 400, body: JSON.stringify({ error: 'template_id required' }) };
        const [ph, tk, gt, sm, lots] = await Promise.all([
          supabaseRequest('GET', `sched_template_phases?template_id=eq.${template_id}&select=id`),
          supabaseRequest('GET', `sched_template_tasks?template_id=eq.${template_id}&select=id`),
          supabaseRequest('GET', `sched_template_gates?template_id=eq.${template_id}&select=id`),
          supabaseRequest('GET', `sched_template_stage_map?template_id=eq.${template_id}&select=id`),
          supabaseRequest('GET', `sched_lots?template_id=eq.${template_id}&select=id`)
        ]);
        return { statusCode: 200, body: JSON.stringify({
          phases: (ph.data||[]).length, tasks: (tk.data||[]).length,
          gates: (gt.data||[]).length, stages: (sm.data||[]).length,
          lots_using: (lots.data||[]).length
        }) };
      }

      case 'getTemplateBuilder': {
        // Full editable payload for one template: phases + tasks (with real ids).
        const { template_id } = payload;
        if (!template_id) return { statusCode: 400, body: JSON.stringify({ error: 'template_id required' }) };
        const [ph, tk, tpl] = await Promise.all([
          supabaseRequest('GET', `sched_template_phases?template_id=eq.${template_id}&select=*&order=phase_order`),
          supabaseRequest('GET', `sched_template_tasks?template_id=eq.${template_id}&select=*&order=task_order`),
          supabaseRequest('GET', `sched_templates?id=eq.${template_id}&select=*`)
        ]);
        return { statusCode: 200, body: JSON.stringify({
          template: (tpl.data || [])[0] || null,
          phases: ph.data || [],
          tasks: tk.data || []
        }) };
      }

      case 'upsertTemplatePhase': {
        const { id, template_id, name, phase_order } = payload;
        if (!id && (!template_id || !name)) {
          return { statusCode: 400, body: JSON.stringify({ error: 'template_id and name required' }) };
        }
        let r;
        if (id) {
          const upd = {};
          if (name !== undefined) upd.name = name;
          if (phase_order !== undefined) upd.phase_order = phase_order;
          r = await supabaseRequest('PATCH', `sched_template_phases?id=eq.${id}`, upd);
        } else {
          r = await supabaseRequest('POST', 'sched_template_phases', {
            template_id, name, phase_order: phase_order != null ? phase_order : 0
          });
        }
        const row = Array.isArray(r.data) ? r.data[0] : r.data;
        return { statusCode: 200, body: JSON.stringify(row || null) };
      }

      case 'deleteTemplatePhase': {
        const { id } = payload;
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
        const t = await supabaseRequest('GET', `sched_template_tasks?phase_id=eq.${id}&select=id&limit=1`);
        if ((t.data || []).length) {
          return { statusCode: 200, body: JSON.stringify({ error: 'This phase still has tasks. Move or delete them first.' }) };
        }
        await supabaseRequest('DELETE', `sched_template_phases?id=eq.${id}`);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'upsertTemplateTask': {
        const { id, template_id, bt_num, name, phase_id, duration, lag,
                relative_start, relative_finish, predecessors, is_critical,
                task_type, task_order, notification } = payload;
        if (!id && (!template_id || !name)) {
          return { statusCode: 400, body: JSON.stringify({ error: 'template_id and name required' }) };
        }
        const f = {};
        if (bt_num !== undefined)          f.bt_num = bt_num;
        if (name !== undefined)            f.name = name;
        if (phase_id !== undefined)        f.phase_id = phase_id;
        if (duration !== undefined)        f.duration = duration;
        if (lag !== undefined)             f.lag = lag;
        if (relative_start !== undefined)  f.relative_start = relative_start;
        if (relative_finish !== undefined) f.relative_finish = relative_finish;
        if (predecessors !== undefined)    f.predecessors = predecessors;
        if (is_critical !== undefined)     f.is_critical = is_critical;
        if (task_type !== undefined)       f.task_type = task_type;
        if (task_order !== undefined)      f.task_order = task_order;
        if (notification !== undefined)    f.notification = notification;
        let r;
        if (id) {
          r = await supabaseRequest('PATCH', `sched_template_tasks?id=eq.${id}`, f);
        } else {
          f.template_id = template_id;
          if (f.task_type === undefined) f.task_type = 'work';
          r = await supabaseRequest('POST', 'sched_template_tasks', f);
        }
        const row = Array.isArray(r.data) ? r.data[0] : r.data;
        return { statusCode: 200, body: JSON.stringify(row || null) };
      }

      case 'deleteTemplateTask': {
        const { id } = payload;
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
        // clear any stage-map trigger referencing this task
        await supabaseRequest('DELETE', `sched_stage_map_tasks?task_id=eq.${id}`);
        await supabaseRequest('DELETE', `sched_template_tasks?id=eq.${id}`);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

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
        if (r.error) {
          return { statusCode: 200, body: JSON.stringify({ error: 'DB(' + r.status + '): ' + r.error }) };
        }
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'getStaleCriticalTasks': {
        // Flags critical tasks that became "next in line" (all predecessors finished)
        // but weren't completed within duration + GRACE working days.
        // Eligible date = max(actual_finish of predecessors). Ticker starts then.
        // Computed live from existing data — no stamping, works retroactively.
        const GRACE = (payload && payload.grace_days != null) ? payload.grace_days : 3;
        const addWD = (start, off) => { // off working days after start (off=0 => same day)
          const d = new Date(start); d.setHours(0,0,0,0); let c = 0;
          while (c < off) { d.setDate(d.getDate()+1); const w=d.getDay(); if(w!==0&&w!==6) c++; }
          return d;
        };
        const today = new Date(); today.setHours(0,0,0,0);

        const lots = await supabaseRequest('GET', 'sched_lots?select=id,lot_number,community,builder_name,status&status=eq.active');
        const lotRows = lots.data || [];
        const ids = lotRows.map(l=>l.id);
        const lotById = {}; lotRows.forEach(l=>lotById[l.id]=l);
        const stale = [];
        if (ids.length) {
          // Per-lot fetch to avoid PostgREST's 1000-row cap on combined queries.
          const rows = [];
          const byLot = {};
          await Promise.all(ids.map(async (lotId) => {
            const r = await supabaseRequest('GET',
              `sched_lot_tasks?lot_id=eq.${lotId}&select=lot_id,bt_num,name,status,actual_finish,duration,predecessors,is_critical`);
            (r.data || []).forEach(row => { rows.push(row); (byLot[row.lot_id]=byLot[row.lot_id]||{})[row.bt_num]=row; });
          }));
          rows.forEach(r=>{
            if (!r.is_critical) return;
            if (r.status === 'finished') return;
            const lotTasks = byLot[r.lot_id];
            const preds = r.predecessors || [];
            // eligible only if ALL predecessors are finished
            let eligible = null, allDone = true;
            if (preds.length === 0) { eligible = null; } // no preds: can't anchor a start; skip
            for (const p of preds) {
              const pt = lotTasks[p];
              if (!pt || pt.status !== 'finished' || !pt.actual_finish) { allDone = false; break; }
              const f = new Date(pt.actual_finish); if (!eligible || f > eligible) eligible = f;
            }
            if (!allDone || !eligible) return; // not yet next-in-line, or no anchor date
            const dur = r.duration || 1;
            const expectedDone = addWD(eligible, dur + GRACE);
            if (today > expectedDone) {
              const L = lotById[r.lot_id] || {};
              // working days overdue
              let od=0, cur=new Date(expectedDone);
              while (cur < today) { cur.setDate(cur.getDate()+1); const w=cur.getDay(); if(w!==0&&w!==6) od++; }
              stale.push({
                lot_id: r.lot_id, lot_number: L.lot_number, community: L.community, builder_name: L.builder_name,
                bt_num: r.bt_num, task_name: r.name, status: r.status||'not_started',
                eligible_date: eligible.toISOString().slice(0,10),
                expected_done: expectedDone.toISOString().slice(0,10),
                days_overdue: od
              });
            }
          });
        }
        stale.sort((a,b)=> b.days_overdue - a.days_overdue);
        return { statusCode: 200, body: JSON.stringify(stale) };
      }

      // ══════════════════════════════════════════════════════
      // DELAY REASON CAPTURE
      // ══════════════════════════════════════════════════════

      case 'getDelayReasons': {
        const inc = payload && payload.include_archived;
        const filt = inc ? '' : '&is_archived=eq.false';
        const r = await supabaseRequest('GET', `sched_delay_reasons?select=*${filt}&order=sort_order,label`);
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'upsertDelayReason': {
        const { id, label, sort_order, is_archived } = payload;
        if (!id && !label) {
          return { statusCode: 400, body: JSON.stringify({ error: 'label required' }) };
        }
        let r;
        if (id) {
          const upd = {};
          if (label !== undefined) upd.label = label;
          if (sort_order !== undefined) upd.sort_order = sort_order;
          if (is_archived !== undefined) upd.is_archived = is_archived;
          r = await supabaseRequest('PATCH', `sched_delay_reasons?id=eq.${id}`, upd);
        } else {
          r = await supabaseRequest('POST', 'sched_delay_reasons', {
            label, sort_order: sort_order != null ? sort_order : 50, is_archived: false
          });
        }
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'addTaskDelay': {
        // One row per lot+task. source_lot_id set when inherited via bulk push,
        // so reporting can count BY LOT (all rows) or BY EVENT (dedupe by source).
        const { lot_id, lot_task_id, bt_num, task_name, lot_number, community, builder_name,
                reason_id, reason_label, note, days_late, expected_done, actual_finish,
                source_lot_id, author } = payload;
        if (!lot_task_id || !reason_label) {
          return { statusCode: 400, body: JSON.stringify({ error: 'lot_task_id and reason_label are required' }) };
        }
        const r = await supabaseRequest('POST', 'sched_task_delays', {
          lot_id: lot_id || null, lot_task_id, bt_num: bt_num != null ? bt_num : null,
          task_name: task_name || null, lot_number: lot_number || null,
          community: community || null, builder_name: builder_name || null,
          reason_id: reason_id || null, reason_label,
          note: note || '', days_late: days_late != null ? days_late : 0,
          expected_done: expected_done || null, actual_finish: actual_finish || null,
          source_lot_id: source_lot_id || null, author: author || null
        });
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'getTaskDelays': {
        // Reporting feed. Optional filters: community, builder_name, since (date).
        const p = payload || {};
        let q = 'sched_task_delays?select=*';
        if (p.community)    q += `&community=eq.${encodeURIComponent(p.community)}`;
        if (p.builder_name) q += `&builder_name=eq.${encodeURIComponent(p.builder_name)}`;
        if (p.since)        q += `&created_at=gte.${p.since}`;
        q += '&order=created_at.desc';
        const r = await supabaseRequest('GET', q);
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'getDelaysForTask': {
        // Used by bulk push to inherit the source lot's reason for a given task.
        const { lot_id, bt_num } = payload;
        if (!lot_id || bt_num == null) {
          return { statusCode: 400, body: JSON.stringify({ error: 'lot_id and bt_num required' }) };
        }
        const r = await supabaseRequest('GET',
          `sched_task_delays?lot_id=eq.${lot_id}&bt_num=eq.${bt_num}&select=*&order=created_at.desc&limit=1`);
        return { statusCode: 200, body: JSON.stringify((r.data || [])[0] || null) };
      }

      case 'getAllLotPhases': {
        // For every active lot: compute active phase and per-phase task snapshots.
        // ACTIVE PHASE = the furthest phase that contains a started/finished CRITICAL task.
        // Non-critical tasks NEVER dictate the active phase (float items don't hold it back
        // or push it forward). Also returns "behind": incomplete CRITICAL tasks in phases
        // earlier than the active phase (bypassed critical work).
        // Returns { [lot_id]: { activePhase, activePhaseName,
        //   phases: { [phase_order]: {name, tasks:[{num,name,status,is_critical}]} },
        //   behind: [{num,name,status,phase_order,phase_name}] } }
        const lots = await supabaseRequest('GET', 'sched_lots?select=id,status&status=eq.active');
        const lotRows = lots.data || [];
        const ids = lotRows.map(l => l.id);
        const out = {};
        if (ids.length) {
          // Fetch per-lot to avoid PostgREST's hard 1000-row cap on combined queries.
          // Each lot has ~100 tasks, so no single query is ever near the cap.
          const byLot = {};
          await Promise.all(ids.map(async (lotId) => {
            const r = await supabaseRequest('GET',
              `sched_lot_tasks?lot_id=eq.${lotId}&select=lot_id,bt_num,name,status,phase_order,phase_name,task_order,is_critical&order=task_order`);
            byLot[lotId] = r.data || [];
          }));
          Object.keys(byLot).forEach(lotId => {
            const ts = byLot[lotId];
            // ACTIVE PHASE = furthest phase_order among CRITICAL tasks that are started or finished
            let activePhase = null, activePhaseName = null;
            ts.forEach(r => {
              if (r.is_critical && (r.status === 'started' || r.status === 'finished')) {
                if (activePhase === null || r.phase_order > activePhase) {
                  activePhase = r.phase_order; activePhaseName = r.phase_name;
                }
              }
            });
            // fallback: nothing critical started yet -> earliest phase that has any task
            if (activePhase === null && ts.length) {
              activePhase = ts[0].phase_order; activePhaseName = ts[0].phase_name;
            }
            // per-phase snapshot (all tasks, with critical flag)
            const phases = {};
            ts.forEach(r => {
              const p = r.phase_order;
              (phases[p] = phases[p] || { name: r.phase_name, tasks: [] })
                .tasks.push({ num: r.bt_num, name: r.name, status: r.status || 'not_started', is_critical: !!r.is_critical });
            });
            // BEHIND = incomplete CRITICAL tasks in phases earlier than active
            const behind = ts.filter(r =>
              r.is_critical && r.status !== 'finished' && r.phase_order < activePhase
            ).map(r => ({ num: r.bt_num, name: r.name, status: r.status || 'not_started', phase_order: r.phase_order, phase_name: r.phase_name }));
            out[lotId] = { activePhase, activePhaseName, phases, behind };
          });
        }
        return { statusCode: 200, body: JSON.stringify(out) };
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

      case 'bulkUpdateLotTasks': {
        // One round-trip from the browser; N task writes done server-side.
        // payload.updates = [{task_id, status?, actual_start?, actual_finish?, vendor_confirmed?, est_start_date?}, ...]
        // payload.lot_id (optional) + payload.reported_stage/true_stage (optional) => one lot stage write at the end.
        const { updates, lot_id, reported_stage, true_stage } = payload;
        if (!Array.isArray(updates)) {
          return { statusCode: 400, body: JSON.stringify({ error: 'updates array is required' }) };
        }
        const stamp = new Date().toISOString();
        let done = 0; const failed = [];
        for (const u of updates) {
          if (!u || !u.task_id) { failed.push({ task_id: u && u.task_id, error: 'missing task_id' }); continue; }
          const upd = { updated_at: stamp };
          if (u.status !== undefined) upd.status = u.status;
          if (u.actual_start !== undefined) upd.actual_start = u.actual_start;
          if (u.actual_finish !== undefined) upd.actual_finish = u.actual_finish;
          if (u.vendor_confirmed !== undefined) upd.vendor_confirmed = u.vendor_confirmed;
          if (u.est_start_date !== undefined) upd.est_start_date = u.est_start_date;
          const r = await supabaseRequest('PATCH', `sched_lot_tasks?id=eq.${u.task_id}`, upd);
          if (r.status && r.status >= 400) failed.push({ task_id: u.task_id, error: r.error }); else done++;
        }
        // one lot-level write: stage (if provided) + touch timestamp
        if (lot_id) {
          const lotUpd = { last_task_update: stamp };
          if (reported_stage !== undefined) lotUpd.reported_stage = reported_stage;
          if (true_stage !== undefined) lotUpd.true_stage = true_stage;
          await supabaseRequest('PATCH', `sched_lots?id=eq.${lot_id}`, lotUpd);
        }
        return { statusCode: 200, body: JSON.stringify({ done, failed }) };
      }

      case 'updateScheduleLotTask': {
        const { task_id, lot_id, status, actual_start, actual_finish, vendor_confirmed, est_start_date } = payload;
        if (!task_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'task_id is required' }) };
        }
        const updates = { updated_at: new Date().toISOString() };
        if (status !== undefined) updates.status = status;
        if (actual_start !== undefined) updates.actual_start = actual_start;
        if (actual_finish !== undefined) updates.actual_finish = actual_finish;
        if (vendor_confirmed !== undefined) updates.vendor_confirmed = vendor_confirmed;
        if (est_start_date !== undefined) updates.est_start_date = est_start_date;
        const r = await supabaseRequest('PATCH', `sched_lot_tasks?id=eq.${task_id}`, updates);
        if (lot_id) {
          await supabaseRequest('PATCH', `sched_lots?id=eq.${lot_id}`, { last_task_update: new Date().toISOString() });
        }
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      // ── Item 4: stamp lot as complete with frozen health delta ──
      case 'stampLotComplete': {
        const { id, completion_stamped_at, completion_wd_elapsed, completion_health_delta } = payload;
        if (!id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'id is required' }) };
        }
        const r = await supabaseRequest('PATCH', `sched_lots?id=eq.${id}`, {
          completion_stamped_at: completion_stamped_at || new Date().toISOString(),
          completion_wd_elapsed: completion_wd_elapsed != null ? completion_wd_elapsed : null,
          completion_health_delta: completion_health_delta != null ? completion_health_delta : null,
          updated_at: new Date().toISOString()
        });
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      // ── edit a single lot task (predecessors, lag, duration, phase) ──
      case 'editLotTask': {
        const { task_id, predecessors, lag, duration, phase_name, phase_order } = payload;
        if (!task_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'task_id is required' }) };
        }
        const updates = { updated_at: new Date().toISOString() };
        if (predecessors !== undefined) updates.predecessors = predecessors;
        if (lag !== undefined) updates.lag = lag;
        if (duration !== undefined) updates.duration = duration;
        if (phase_name !== undefined) updates.phase_name = phase_name;
        if (phase_order !== undefined) updates.phase_order = phase_order;
        const r = await supabaseRequest('PATCH', `sched_lot_tasks?id=eq.${task_id}`, updates);
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
        const notes = await supabaseRequest('GET', `sched_lot_task_notes?flag=in.(red,yellow)&select=*&order=created_at.desc`);
        const rows = notes.data || [];
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

      // ══════════════════════════════════════════════════════
      // COMPANIES
      // ══════════════════════════════════════════════════════

      case 'getCompanies': {
        const r = await supabaseRequest('GET', 'sched_companies?select=*&order=name');
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'addCompany': {
        const { name } = payload;
        if (!name) return { statusCode: 400, body: JSON.stringify({ error: 'name required' }) };
        const r = await supabaseRequest('POST', 'sched_companies', { name, created_at: new Date().toISOString() });
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'deleteCompany': {
        const { id } = payload;
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
        await supabaseRequest('DELETE', `sched_companies?id=eq.${id}`);
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      // ══════════════════════════════════════════════════════
      // SUBDIVISIONS
      // ══════════════════════════════════════════════════════

      case 'getSubdivisions': {
        const { include_archived } = payload || {};
        const filter = include_archived ? '' : '&is_archived=eq.false';
        const r = await supabaseRequest('GET', `sched_subdivisions?select=*&order=code${filter}`);
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'upsertSubdivision': {
        const { id, ...fields } = payload;
        fields.updated_at = new Date().toISOString();
        let r;
        if (id) {
          r = await supabaseRequest('PATCH', `sched_subdivisions?id=eq.${id}`, fields);
        } else {
          fields.created_at = new Date().toISOString();
          r = await supabaseRequest('POST', 'sched_subdivisions', fields);
        }
        return { statusCode: 200, body: JSON.stringify(r.data) };
      }

      case 'getSubdivisionLots': {
        const { subdivision_id } = payload || {};
        const filter = subdivision_id ? `?subdivision_id=eq.${subdivision_id}&` : '?';
        const r = await supabaseRequest('GET', `sched_subdivision_lots${filter}select=*&order=sort_order,lot_number`);
        return { statusCode: 200, body: JSON.stringify(r.data || []) };
      }

      case 'saveSubdivisionLots': {
        const { subdivision_id, rows } = payload;
        if (!subdivision_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'subdivision_id required' }) };
        }
        await supabaseRequest('DELETE', `sched_subdivision_lots?subdivision_id=eq.${subdivision_id}`);
        if (rows && rows.length) {
          const toInsert = rows
            .filter(r => r.lot_number || r.address)
            .map((r, i) => ({
              subdivision_id,
              lot_number: r.lot_number || null,
              address: r.address || null,
              lot_size: r.lot_size || null,
              notes: r.notes || null,
              sort_order: r.sort_order != null ? r.sort_order : i,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }));
          if (toInsert.length) {
            await supabaseRequest('POST', 'sched_subdivision_lots', toInsert);
          }
        }
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'getSubdivisionTemplates': {
        const { subdivision_id } = payload;
        if (!subdivision_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'subdivision_id required' }) };
        }
        const r = await supabaseRequest('GET', `sched_subdivision_templates?subdivision_id=eq.${subdivision_id}&select=template_id`);
        return { statusCode: 200, body: JSON.stringify((r.data || []).map(x => x.template_id)) };
      }

      case 'saveSubdivisionTemplates': {
        const { subdivision_id, template_ids } = payload;
        if (!subdivision_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'subdivision_id required' }) };
        }
        await supabaseRequest('DELETE', `sched_subdivision_templates?subdivision_id=eq.${subdivision_id}`);
        if (template_ids && template_ids.length) {
          const rows = template_ids.map(tid => ({ subdivision_id, template_id: tid }));
          await supabaseRequest('POST', 'sched_subdivision_templates', rows);
        }
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'setBuilderPin': {
        const { name, pin } = payload;
        if (!name || !pin || !/^\d{4}$/.test(pin)) {
          return { statusCode: 400, body: JSON.stringify({ error: 'name and 4-digit pin required' }) };
        }
        await supabaseRequest('PATCH', `field_ops_builders?name=eq.${encodeURIComponent(name)}`, {
          pin_hash: pin, temp_pin: null, failed_attempts: 0, is_locked: false, updated_at: new Date().toISOString()
        });
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'unlockBuilder': {
        const { name } = payload;
        if (!name) return { statusCode: 400, body: JSON.stringify({ error: 'name required' }) };
        await supabaseRequest('PATCH', `field_ops_builders?name=eq.${encodeURIComponent(name)}`, {
          is_locked: false, failed_attempts: 0, updated_at: new Date().toISOString()
        });
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      case 'getTemplateTasks': {
        const { template_id } = payload;
        if (!template_id) {
          return { statusCode: 400, body: JSON.stringify({ error: 'template_id is required' }) };
        }
        const phRes = await supabaseRequest('GET', `sched_template_phases?template_id=eq.${template_id}&select=id,name,phase_order`);
        const phaseMap = {};
        (phRes.data || []).forEach(p => { phaseMap[p.id] = { name: p.name, order: p.phase_order }; });
        const tkRes = await supabaseRequest('GET', `sched_template_tasks?template_id=eq.${template_id}&select=*&order=task_order`);
        const tasks = (tkRes.data || []).map(t => {
          const ph = phaseMap[t.phase_id] || {};
          return {
            bt_num: t.bt_num, name: t.name, phase_name: ph.name || null, phase_order: (ph.order !== undefined ? ph.order : null),
            duration: t.duration, lag: t.lag, relative_start: t.relative_start, predecessors: t.predecessors,
            notification: t.notification, relative_finish: t.relative_finish, is_critical: t.is_critical,
            task_type: t.task_type || 'work', task_order: t.task_order
          };
        });
        return { statusCode: 200, body: JSON.stringify(tasks) };
      }

      case 'migrateOldLot': {
        const { template_id, lot_number, community, builder_name, construction_start_date,
                completed, gates, reported_stage, true_stage } = payload;
        if (!template_id || !lot_number) {
          return { statusCode: 400, body: JSON.stringify({ error: 'template_id and lot_number required' }) };
        }
        const doneMap = {};
        (completed || []).forEach(c => { doneMap[c.bt_num] = { actual_start: c.actual_start || null, actual_finish: c.actual_finish || null }; });

        const phRes = await supabaseRequest('GET', `sched_template_phases?template_id=eq.${template_id}&select=id,name,phase_order`);
        const phaseMap = {};
        (phRes.data || []).forEach(p => { phaseMap[p.id] = { name: p.name, order: p.phase_order }; });
        const tkRes = await supabaseRequest('GET', `sched_template_tasks?template_id=eq.${template_id}&select=*&order=task_order`);
        const tasks = tkRes.data || [];
        if (!tasks.length) {
          return { statusCode: 400, body: JSON.stringify({ error: 'template has no tasks' }) };
        }

        const lotRes = await supabaseRequest('POST', 'sched_lots', {
          template_id, lot_number, community: community || null, builder_name: builder_name || null,
          construction_start_date: construction_start_date || null, status: 'active',
          reported_stage: reported_stage || null, true_stage: true_stage || null,
          last_task_update: new Date().toISOString()
        });
        if (lotRes.error || !lotRes.data) {
          return { statusCode: 500, body: JSON.stringify({ error: 'lot insert failed: ' + (lotRes.error || 'unknown') }) };
        }
        const lot = Array.isArray(lotRes.data) ? lotRes.data[0] : lotRes.data;
        const lot_id = lot.id;

        const lotTasks = tasks.map(t => {
          const ph = phaseMap[t.phase_id] || {};
          const d = doneMap[t.bt_num];
          return {
            lot_id, source_task_id: t.id, bt_num: t.bt_num, name: t.name,
            phase_name: ph.name || null, phase_order: (ph.order !== undefined ? ph.order : null),
            duration: t.duration, lag: t.lag, relative_start: t.relative_start, predecessors: t.predecessors,
            notification: t.notification, relative_finish: t.relative_finish, is_critical: t.is_critical,
            task_type: t.task_type || 'work', task_order: t.task_order,
            status: d ? 'finished' : 'not_started',
            actual_start: d ? d.actual_start : null,
            actual_finish: d ? d.actual_finish : null
          };
        });
        const ins = await supabaseRequest('POST', 'sched_lot_tasks', lotTasks);
        if (ins.error) {
          await supabaseRequest('DELETE', `sched_lots?id=eq.${lot_id}`);
          return { statusCode: 500, body: JSON.stringify({ error: 'task insert failed: ' + ins.error }) };
        }

        const gRes = await supabaseRequest('GET', `sched_template_gates?template_id=eq.${template_id}&select=*`);
        const tgates = gRes.data || [];
        if (tgates.length) {
          const g = gates || {};
          const gateRows = tgates.map(tg => {
            const key = (tg.name || '').toLowerCase();
            const conf = !!g[key];
            return { lot_id, source_gate_id: tg.id, gate_name: tg.name, confirmed: conf, confirmed_at: conf ? new Date().toISOString() : null };
          });
          await supabaseRequest('POST', 'sched_lot_gate_state', gateRows);
        }

        return { statusCode: 200, body: JSON.stringify({ success: true, lot_id, tasks: lotTasks.length, completed: (completed||[]).length }) };
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
    }

  } catch(err) {
    console.error('Handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.toString() }) };
  }
};
