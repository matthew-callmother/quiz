(()=>{

  // ---------- tiny utils ----------
  const $ = (s, r=document) => r.querySelector(s);
  const el = (t,c) => { const e=document.createElement(t); if(c) e.className=c; return e; };
  const on = (e,ev,fn) => e && e.addEventListener(ev,fn);
  const GA = (ev,params) => { try { window.gtag && gtag('event',ev,params) } catch(_){ } };

  // ---------- logic helpers ----------
  function passesShowIf(flags,node){
    if(!node || !node.showif) return true;
    return node.showif.every(c=>{
      const v = flags[c.path];
      if('eq' in c) return v === c.eq;
      if('neq' in c) return v !== c.neq;
      if('in' in c) return (c.in||[]).includes(v);
      if('exists' in c) return c.exists ? v !== undefined : v === undefined;
      return true;
    });
  }

  const isMulti = q => (q.type || 'single') === 'multi';

  function applyAnswer(state,q,a){
    state.trail.push({
      qId: q.id,
      question: q.question || q.text || '',
      answerId: a.id || null,
      answerLabel: a.label || a.answer || ''
    });
    if(a.set) Object.assign(state.flags, a.set);
    if(a.add) for(const [k,v] of Object.entries(a.add)){
      state.scores[k] = (state.scores[k] || 0) + Number(v || 0);
    }
  }

  function progressPct(state){
    const vis = state.questions.filter(q => passesShowIf(state.flags,q)).length || 1;
    const done = Math.min(state.answeredCount, vis);
    return Math.round((done/vis)*100);
  }

  function pickResult(options,scores){
    let best = options?.[0]?.id, bestVal = -Infinity;
    for(const o of (options||[])){
      const v = Number(scores[o.id] || 0);
      if(v > bestVal){ bestVal=v; best=o.id; }
    }
    return best;
  }

  // ---------- UPDATED: NO JSON CONTENT-TYPE HEADER ----------
  async function post(url,payload){
    if(!url) return;
    try{
      await fetch(url,{
        method:'POST',
        body: JSON.stringify(payload)  // text/plain → no CORS preflight
      });
    }catch(err){
      console.error('quiz webhook fetch failed', err);
    }
  }

  // ---------- main ----------
  async function init(scriptEl){
    const rootSel = scriptEl.getAttribute('data-root') || '#wh-quiz';
    const root = $(rootSel) || (()=>{ const d=el('div'); d.id=rootSel.replace('#',''); document.body.appendChild(d); return d; })();

    // load config
    let cfg;
    try{
      const res = await fetch(scriptEl.dataset.config, { cache:'no-store' });
      cfg = await res.json();
    }catch(_){
      root.textContent = 'Failed to load quiz.';
      GA('quiz_error',{reason:'config_load_failed'});
      return;
    }

    // state
    const state = {
      cfg,
      flags:{},
      scores: Object.fromEntries((cfg.options||[]).map(o=>[o.id,0])),
      stepIndex:0,
      answeredCount:0,
      started:false,
      questions: cfg.questions || [],
      selections:{},
      selectionOrder:{},
      trail:[],
      contact:null
    };

    function header(container){
      const h = el('div','quiz-header');
      const t = el('div','quiz-title'); t.textContent = cfg.title || ''; h.appendChild(t);
      if(cfg.subtitle){
        const s = el('div','quiz-subtitle'); s.textContent = cfg.subtitle; h.appendChild(s);
      }
      const p = el('div','quiz-progress');
      const b = el('div','quiz-progress-bar');
      b.style.width = progressPct(state) + '%';
      p.appendChild(b);
      h.appendChild(p);
      container.appendChild(h);
    }

    const nextVisibleIndex = from => {
      let i = from;
      while(i < state.questions.length && !passesShowIf(state.flags, state.questions[i])) i++;
      return (i < state.questions.length) ? i : -1;
    };

    function goAdvanceOrEnd(){
      const ni = nextVisibleIndex(state.stepIndex + 1);
      if(ni > -1){ state.stepIndex = ni; render(); return; }
      if(cfg.collect_contact && !state.contact){ showContact(); return; }
      showResult();
    }

    function renderQuestion(q){
      const wrap = el('div','quiz-question');
      const qtext = el('div','quiz-question-text'); qtext.textContent = q.question || q.text || ''; wrap.appendChild(qtext);
      if(q.tooltip){ const tip=el('div','quiz-tooltip'); tip.textContent=q.tooltip; wrap.appendChild(tip); }
      if(q.photo_url){ const ph=el('img','quiz-photo'); ph.src=q.photo_url; ph.alt=''; wrap.appendChild(ph); }

      const list = el('div','quiz-answers');
      const multi = isMulti(q);

      if(multi){
        if(!state.selections[q.id]) state.selections[q.id] = new Set();
        if(!state.selectionOrder[q.id]) state.selectionOrder[q.id] = [];
      }

      (q.answers||[]).forEach((a,idx)=>{
        if(!passesShowIf(state.flags,a)) return;

        const btn = el('button','quiz-answer');
        btn.type='button';
        btn.dataset.aid = a.id || String(idx);
        btn.textContent = a.label || a.answer || `Option ${idx+1}`;

        if(a.photo_url){
          const img=el('img','quiz-answer-photo'); img.src=a.photo_url; img.alt=''; btn.appendChild(img);
        }
        if(a.tooltip){
          const tt=el('div','quiz-answer-tooltip'); tt.textContent=a.tooltip; btn.appendChild(tt);
        }

        if(multi){
          on(btn,'click',()=>{
            const sel = state.selections[q.id];
            const order = state.selectionOrder[q.id];
            const k = btn.dataset.aid;
            const max = q.max || Infinity;

            if(sel.has(k)){
              sel.delete(k);
              const i = order.indexOf(k);
              if(i>-1) order.splice(i,1);
              btn.classList.remove('selected');
              GA('quiz_toggle',{quiz_id:cfg.id,step_id:q.id,answer_id:k,selected:false});
              return;
            }

            if(sel.size >= max && isFinite(max)){
              const oldest = order.shift();
              if(oldest !== undefined){
                sel.delete(oldest);
                [...list.children].forEach(b=>{ if(b.dataset.aid===oldest) b.classList.remove('selected'); });
              }
            }

            sel.add(k);
            order.push(k);
            btn.classList.add('selected');
            GA('quiz_toggle',{quiz_id:cfg.id,step_id:q.id,answer_id:k,selected:true});
          });

        }else{
          on(btn,'click',()=>{
            if(!state.started){ state.started=true; GA('quiz_start',{quiz_id:cfg.id}); }

            GA('quiz_step',{quiz_id:cfg.id,step_id:q.id,step_index:state.stepIndex,answer_label:a.label||'',percent_complete:progressPct(state)});
            applyAnswer(state,q,a);
            state.answeredCount++;

            if(a.next){
              if(a.next.startsWith('result:')){
                showResult(a.next.split(':')[1]); return;
              }
              const nIdx = state.questions.findIndex(qq=>qq.id === a.next);
              if(nIdx > -1){ state.stepIndex = nIdx; render(); return; }
            }

            goAdvanceOrEnd();
          });
        }

        list.appendChild(btn);
      });

      wrap.appendChild(list);

      if(multi){
        const controls = el('div','quiz-multi-controls');
        const nextBtn = el('button','quiz-cta');
        nextBtn.type='button';
        nextBtn.textContent='Next';
        const hint = el('div','quiz-hint');
        controls.appendChild(nextBtn);
        controls.appendChild(hint);
        wrap.appendChild(controls);

        const sel = state.selections[q.id];
        [...list.children].forEach(b => b.classList.toggle('selected', sel.has(b.dataset.aid)));

        on(nextBtn,'click',()=>{
          const ids = Array.from(state.selections[q.id] || []);
          const min = (q.min === 0) ? 0 : (q.min || 1);
          if(ids.length < min){ hint.textContent = `Choose at least ${min}.`; return; }

          if(!state.started){ state.started=true; GA('quiz_start',{quiz_id:cfg.id}); }

          const chosen = (q.answers||[]).filter(a => ids.includes(a.id || ''));
          chosen.forEach(a => applyAnswer(state,q,a));

          state.answeredCount++;
          GA('quiz_step',{quiz_id:cfg.id,step_id:q.id,step_index:state.stepIndex,multi_count:ids.length,percent_complete:progressPct(state)});

          const branch = chosen.find(a => a && a.next);
          if(branch && branch.next){
            if(branch.next.startsWith('result:')){
              showResult(branch.next.split(':')[1]); return;
            }
            const nIdx = state.questions.findIndex(qq=>qq.id === branch.next);
            if(nIdx > -1){ state.stepIndex = nIdx; render(); return; }
          }

          goAdvanceOrEnd();
        });
      }

      return wrap;
    }

    function showContact(){
      const container = el('div','quiz'); header(container);
      const f = el('form','quiz-contact');

      (cfg.contact_fields || ['name','email']).forEach(k=>{
        const w = el('div','field');
        w.innerHTML = `<label>${k.charAt(0).toUpperCase()+k.slice(1)}</label><input name="${k}" required>`;
        f.appendChild(w);
      });

      const hp = el('input'); hp.name='company'; hp.style.display='none'; f.appendChild(hp);

      const btn = el('button','quiz-cta');
      btn.type='submit';
      btn.textContent='See recommendation';
      f.appendChild(btn);

      root.innerHTML='';
      root.appendChild(container);
      container.appendChild(f);

      on(f,'submit', async e=>{
        e.preventDefault();
        if(hp.value) return;

        state.contact = Object.fromEntries(new FormData(f).entries());
        GA('quiz_lead',{quiz_id:cfg.id});

        await post(cfg.webhook,{
          type:'lead',
          quiz_id:cfg.id,
          contact:state.contact,
          trail:state.trail,
          flags:state.flags,
          page:location.href,
          ts:Date.now()
        });

        showResult();
      });
    }

    function showResult(forcedId){
      const resId = forcedId || pickResult(cfg.options || [], state.scores);
      const resOpt = (cfg.options || []).find(o => o.id === resId) || { id:resId, label:resId };

      const container = el('div','quiz'); header(container);

      const res = el('div','quiz-result');
      const ttl = el('div','quiz-result-title');
      ttl.textContent = resOpt.label || 'Result';
      res.appendChild(ttl);

      const rn = (cfg.result_notes && cfg.result_notes[resId]) || {};

      if(rn.photo_url){
        const im = el('img','quiz-result-photo'); im.src=rn.photo_url; im.alt=''; res.appendChild(im);
      }

      if(rn.text){
        const tx = el('div','quiz-result-text'); tx.textContent = rn.text; res.appendChild(tx);
      }

      const ctas = el('div','quiz-ctas');
      const a = el('a','quiz-cta');
      a.href = rn.cta_url || resOpt.cta || cfg.cta_url || '#';
      a.textContent = rn.cta_label || resOpt.cta_label || cfg.cta_label || 'Continue';
      ctas.appendChild(a);

      if(cfg.cta2_url && cfg.cta2_label){
        const a2 = el('a','quiz-cta-secondary');
        a2.href = cfg.cta2_url;
        a2.textContent = cfg.cta2_label;
        ctas.appendChild(a2);
      }

      const re = el('button','quiz-restart');
      re.textContent='Restart';
      on(re,'click',()=>{ GA('quiz_restart',{quiz_id:cfg.id}); location.reload(); });
      ctas.appendChild(re);

      res.appendChild(ctas);

      root.innerHTML='';
      root.appendChild(container);
      container.appendChild(res);

      GA('quiz_complete',{quiz_id:cfg.id,result_id:resId,percent_complete:100});

      post(cfg.webhook,{
        type:'completion',
        quiz_id:cfg.id,
        result_id:resId,
        result_label:resOpt.label || resId,
        scores:state.scores,
        flags:state.flags,
        trail:state.trail,
        contact:state.contact || null,
        page:location.href,
        ts:Date.now()
      });
    }

    function render(){
      const q = state.questions[state.stepIndex];

      if(q && !passesShowIf(state.flags,q)){
        const ni = nextVisibleIndex(state.stepIndex + 1);
        if(ni>-1){ state.stepIndex = ni; render(); return; }
        if(cfg.collect_contact && !state.contact){ showContact(); return; }
        showResult();
        return;
      }

      const container = el('div','quiz'); header(container);
      if(q){
        container.appendChild(renderQuestion(q));
      }else{
        showResult();
        return;
      }

      root.innerHTML='';
      root.appendChild(container);
    }

    render();
  }

  // ---------- boot ----------
  function boot(){
    const scripts=[...document.scripts].filter(s=>s.dataset && s.dataset.config);
    scripts.forEach(s=>{
      if(s.dataset.booted==='1') return;
      s.dataset.booted='1';
      requestAnimationFrame(()=>init(s));
    });
  }

  (document.readyState === 'loading')
    ? document.addEventListener('DOMContentLoaded', boot, {once:true})
    : boot();

})();
