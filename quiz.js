(() => {
  // ------- helpers -------
  const getEl = (sel, root = document) => root.querySelector(sel);
  const ce = (tag, cls) => { const el = document.createElement(tag); if (cls) el.className = cls; return el; };
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  function sendGA(event, params) { try { window.gtag && window.gtag('event', event, params); } catch(_) {} }

  // Simple conditions: eq / neq / in / exists
  function passesShowIf(flags, node) {
    if (!node || !node.showif) return true;
    return node.showif.every(c => {
      const v = flags[c.path];
      if ('eq' in c) return v === c.eq;
      if ('neq' in c) return v !== c.neq;
      if ('in' in c) return (c.in || []).includes(v);
      if ('exists' in c) return c.exists ? v !== undefined : v === undefined;
      return true;
    });
  }

  // Compute progress % based on answered vs visible questions up to current
  function progressPercent(state) {
    const visible = state.questions.filter(q => passesShowIf(state.flags, q));
    if (!visible.length) return 0;
    const answered = Math.min(state.answeredCount, visible.length);
    return Math.round((answered / visible.length) * 100);
  }

  // Pick max score (stable by options order)
  function pickResult(options, scores) {
    let best = options[0].id, bestVal = -Infinity;
    for (const o of options) {
      const v = Number(scores[o.id] || 0);
      if (v > bestVal) { bestVal = v; best = o.id; }
    }
    return best;
  }

  // ------- main -------
  async function init(scriptEl) {
    const rootSel = scriptEl.getAttribute('data-root') || '#wh-quiz';
    const root = getEl(rootSel) || (() => { const d = ce('div'); d.id = rootSel.replace('#',''); document.body.appendChild(d); return d; })();

    const cfgUrl = scriptEl.getAttribute('data-config');
    if (!cfgUrl) {
      root.textContent = 'Quiz config URL missing.';
      sendGA('quiz_error', { reason: 'missing_config' });
      return;
    }

    let cfg;
    try {
      const r = await fetch(cfgUrl, { cache: 'no-store' });
      cfg = await r.json();
    } catch (e) {
      root.textContent = 'Failed to load quiz.';
      sendGA('quiz_error', { reason: 'config_load_failed' });
      return;
    }

    // state
    const state = {
      cfg,
      flags: {},
      scores: Object.fromEntries((cfg.options || []).map(o => [o.id, 0])),
      stepIndex: 0,
      answeredCount: 0,
      questions: cfg.questions || [],
      started: false
    };

    function reset() {
      state.flags = {};
      for (const k of Object.keys(state.scores)) state.scores[k] = 0;
      state.stepIndex = 0;
      state.answeredCount = 0;
      state.started = false;
      render();
    }

    function visibleQuestionsUpTo(idx) {
      return state.questions.slice(0, idx + 1).filter(q => passesShowIf(state.flags, q));
    }

    function gotoNext(currentQ, answerObj) {
      // set flags
      if (answerObj && answerObj.set) Object.assign(state.flags, answerObj.set);

      // add scores
      if (answerObj && answerObj.add) {
        for (const [k, v] of Object.entries(answerObj.add)) {
          state.scores[k] = (state.scores[k] || 0) + Number(v || 0);
        }
      }

      state.answeredCount++;

      // branch via explicit next
      if (answerObj && answerObj.next) {
        // jump to that question id if exists
        const idx = state.questions.findIndex(q => q.id === answerObj.next);
        if (idx > -1) { state.stepIndex = idx; render(); return; }
        // allow next="result:<id>" to jump to end with forced result
        if (answerObj.next.startsWith('result:')) {
          showResult(answerObj.next.split(':')[1]);
          return;
        }
      }

      // otherwise, move forward to the next visible question
      let i = state.stepIndex + 1;
      while (i < state.questions.length) {
        if (passesShowIf(state.flags, state.questions[i])) { state.stepIndex = i; render(); return; }
        i++;
      }
      // no more questions → result
      showResult();
    }

    function showHeader(container) {
      const h = ce('div', 'quiz-header');
      const t = ce('div', 'quiz-title'); t.textContent = cfg.title || '';
      const s = ce('div', 'quiz-subtitle'); s.textContent = cfg.subtitle || '';
      const progWrap = ce('div', 'quiz-progress');
      const progBar = ce('div', 'quiz-progress-bar');
      progBar.style.width = `${progressPercent(state)}%`;
      progWrap.appendChild(progBar);
      h.appendChild(t);
      if (cfg.subtitle) h.appendChild(s);
      h.appendChild(progWrap);
      container.appendChild(h);
    }

    function renderQuestion(q) {
      const wrap = ce('div', 'quiz-question');
      const qtext = ce('div', 'quiz-question-text'); qtext.textContent = q.question || q.text || '';
      wrap.appendChild(qtext);

      if (q.tooltip) {
        const tip = ce('div', 'quiz-tooltip'); tip.textContent = q.tooltip;
        wrap.appendChild(tip);
      }

      if (q.photo_url) {
        const ph = ce('img', 'quiz-photo'); ph.src = q.photo_url; ph.alt = '';
        wrap.appendChild(ph);
      }

      const list = ce('div', 'quiz-answers');

      (q.answers || []).forEach((a, idx) => {
        if (!passesShowIf(state.flags, a)) return;

        const btn = ce('button', 'quiz-answer');
        // Accessible label text only; styling via CSS
        btn.textContent = a.label || a.answer || `Option ${idx+1}`;

        // optional per-answer tooltip photo
        if (a.tooltip) {
          const t = ce('div', 'quiz-answer-tooltip'); t.textContent = a.tooltip;
          btn.appendChild(t);
        }
        if (a.photo_url) {
          const img = ce('img', 'quiz-answer-photo'); img.src = a.photo_url; img.alt = '';
          btn.appendChild(img);
        }

        on(btn, 'click', () => {
          if (!state.started) {
            state.started = true;
            sendGA('quiz_start', { quiz_id: cfg.id });
          }
          const pct = progressPercent(state);
          sendGA('quiz_step', {
            quiz_id: cfg.id,
            step_id: q.id,
            step_index: state.stepIndex,
            answer_label: a.label || '',
            percent_complete: pct
          });
          gotoNext(q, a);
        });
        list.appendChild(btn);
      });

      wrap.appendChild(list);
      return wrap;
    }

    function showResult(forcedId) {
      const resId = forcedId || pickResult(cfg.options || [], state.scores);
      const resOpt = (cfg.options || []).find(o => o.id === resId) || { id: resId, label: resId };

      const container = ce('div', 'quiz');
      showHeader(container);

      const res = ce('div', 'quiz-result');
      const title = ce('div', 'quiz-result-title'); title.textContent = resOpt.label || 'Result';
      res.appendChild(title);

      // Optional CMS-enhanced result details in config.result_notes[resId]
      const rn = (cfg.result_notes && cfg.result_notes[resId]) || {};
      if (rn.photo_url) {
        const img = ce('img', 'quiz-result-photo'); img.src = rn.photo_url; img.alt = '';
        res.appendChild(img);
      }
      if (rn.text) {
        const p = ce('div', 'quiz-result-text'); p.textContent = rn.text;
        res.appendChild(p);
      }

      const ctas = ce('div', 'quiz-ctas');
      const ctaPrimary = ce('a', 'quiz-cta');
      ctaPrimary.href = rn.cta_url || resOpt.cta || cfg.cta_url || '#';
      ctaPrimary.textContent = rn.cta_label || resOpt.cta_label || cfg.cta_label || 'Continue';
      ctas.appendChild(ctaPrimary);

      // Secondary CTA
      const cta2Url = rn.cta2_url || cfg.cta2_url;
      const cta2Label = rn.cta2_label || cfg.cta2_label;
      if (cta2Url && cta2Label) {
        const ctaSecondary = ce('a', 'quiz-cta-secondary');
        ctaSecondary.href = cta2Url;
        ctaSecondary.textContent = cta2Label;
        ctas.appendChild(ctaSecondary);
      }

      // Restart button (optional)
      const restart = ce('button', 'quiz-restart'); restart.textContent = 'Restart';
      on(restart, 'click', () => { sendGA('quiz_restart', { quiz_id: cfg.id }); reset(); });
      ctas.appendChild(restart);

      res.appendChild(ctas);
      container.appendChild(res);

      root.innerHTML = '';
      root.appendChild(container);

      sendGA('quiz_complete', {
        quiz_id: cfg.id,
        result_id: resId,
        percent_complete: 100
      });
    }

    function render() {
      const q = state.questions[state.stepIndex];

      // If current question is hidden by conditions, auto-advance
      if (q && !passesShowIf(state.flags, q)) {
        // advance forward to next visible, else finish
        let i = state.stepIndex + 1;
        while (i < state.questions.length && !passesShowIf(state.flags, state.questions[i])) i++;
        if (i < state.questions.length) { state.stepIndex = i; return render(); }
        return showResult();
      }

      const container = ce('div', 'quiz');
      showHeader(container);

      if (q) {
        container.appendChild(renderQuestion(q));
      } else {
        // No questions -> immediate result (edge case)
        showResult();
        return;
      }

      root.innerHTML = '';
      root.appendChild(container);
    }

    render();
  }

  // auto-run for any <script src="...wh-quiz.js" data-config="...">
  const scripts = Array.from(document.querySelectorAll('script[src*="wh-quiz.js"]'));
  scripts.forEach(init);
})();
