// CPU separation is a background file job. The original source and clip settings are kept.
const Stems = {
  active: null,
  names: ['vocals', 'drums', 'bass', 'other'],
  dialog(clip, x, y) {
    if (this.active) { this.active.panel?.scrollIntoView?.({ block: 'nearest' }); return; }
    const channel = chan(clip.ch);
    if (!channel?.inst.path || channel.inst.type !== 'audio') return;
    closeMenu();
    const chosen = new Set(this.names);
    const box = h('div', { class: 'menu stem-options' });
    const checks = this.names.map(name => {
      const input = h('input', { type: 'checkbox' }); input.checked = true;
      input.addEventListener('change', () => { if (input.checked) chosen.add(name); else chosen.delete(name); go.disabled = !chosen.size; });
      return h('label', null, input, h('span', null, t('stem.' + name)));
    });
    const mute = h('input', { type: 'checkbox' }); mute.checked = true;
    const go = h('button', { class: 'gl-btn gl-btn-primary gl-btn-sm', onclick: () => {
      closeMenu(); this.start(clip, [...chosen], mute.checked);
    } }, t('stem.go'));
    box.append(h('div', { class: 'mh' }, t('stem.title')), h('p', null, t('stem.explain')),
      ...checks, h('hr'), h('label', null, mute, h('span', null, t('stem.mute'))),
      h('p', null, t('stem.downloadnote')),
      h('div', { class: 'stem-buttons' }, h('button', { class: 'gl-btn gl-btn-ghost gl-btn-sm', onclick: closeMenu }, t('cancel')), go));
    document.body.append(box);
    const rect = box.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    box.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    openMenu = box;
  },
  panel(op) {
    const label = h('span', { role: 'status', 'aria-live': 'polite' });
    const progress = h('progress', { max: 1 });
    const cancel = h('button', { class: 'gl-btn gl-btn-ghost gl-btn-sm', onclick: () => this.cancel() }, t('cancel'));
    const panel = h('div', { class: 'stem-task' }, h('div', { class: 'stem-task-title' }, t('stem.title') + ' · CPU'), label, progress, cancel);
    document.body.append(panel);
    Object.assign(op, { panel, label, progress, cancel });
    this.show(op, 'read', 0);
  },
  show(op, phase, progress) {
    if (!op.label) return;
    op.label.textContent = t('stem.phase.' + phase) + (['download', 'separate', 'write'].includes(phase) ? ' · ' + Math.round(progress * 100) + '%' : '');
    if (phase === 'download' || phase === 'separate') op.progress.value = progress;
    else op.progress.removeAttribute?.('value');
  },
  async cancel() {
    const op = this.active;
    if (!op) return;
    op.cancelRequested = true;
    if (op.cancel) op.cancel.disabled = true;
    this.show(op, 'cancelling', 0);
    if (op.id) {
      try { await api.call('stems_cancel', { id: op.id }); }
      catch (e) { op.cancelRequested = false; if (op.cancel) op.cancel.disabled = false; toast(t('toast.err', { e }), 'err'); }
    }
  },
  async start(clip, selected = this.names, muteOriginal = true) {
    if (this.active || !S.project.clips.includes(clip)) return false;
    const channel = chan(clip.ch);
    if (channel?.inst.type !== 'audio' || !channel.inst.path) return false;
    selected = this.names.filter(n => selected.includes(n));
    if (!selected.length) return false;
    const op = { project: S.project, clip, source: JSON.parse(JSON.stringify(clip)), channel: JSON.parse(JSON.stringify(channel)), selected, muteOriginal, cancelRequested: false, id: null };
    this.active = op;
    this.panel(op);
    let completed = false;
    try {
      op.id = await api.call('stems_start', { input: channel.inst.path, project: S.path, name: channel.name, stems: selected });
      if (!op.id) throw Error(t('stem.unavailable'));
      if (op.cancelRequested) await api.call('stems_cancel', { id: op.id });
      let failures = 0;
      for (;;) {
        let status;
        try { status = await api.call('stems_status', { id: op.id }); failures = 0; }
        catch (e) { if (++failures >= 3) throw e; await new Promise(r => setTimeout(r, 500)); continue; }
        if (!status || status.id !== op.id) throw Error(t('stem.unavailable'));
        this.show(op, op.cancelRequested ? 'cancelling' : status.phase, status.progress || 0);
        if (!status.running) {
          completed = true;
          if (status.cancelled || op.cancelRequested) { toast(t('stem.cancelled'), 'info'); return false; }
          if (status.error) throw Error(status.error);
          return await this.importResult(op, status.outputs);
        }
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (e) { toast(t('toast.err', { e }), 'err'); return false; }
    finally {
      if (!completed && op.id) await api.call('stems_cancel', { id: op.id }).catch(() => {});
      op.panel?.remove();
      if (this.active === op) this.active = null;
    }
  },
  async importResult(op, outputs) {
    if (!Array.isArray(outputs) || outputs.length !== op.selected.length || op.selected.some(n => outputs.filter(o => o.stem === n && typeof o.path === 'string' && o.seconds > 0).length !== 1)) throw Error(t('stem.badresult'));
    if (S.project !== op.project) { toast(t('stem.saved', { path: outputs[0].path.replace(/[\\/][^\\/]+$/, '') }), 'info'); return false; }
    for (const output of outputs) await Waves.load(output.path.split(/[\\/]/).pop(), output.path);
    if (op.cancelRequested) return false;
    if (S.project !== op.project) { toast(t('stem.saved', { path: outputs[0].path.replace(/[\\/][^\\/]+$/, '') }), 'info'); return false; }
    history.edit(() => {
      const P = op.project, source = op.source;
      // A clip edited while the model runs is left as edited; results use its launch position.
      if (op.muteOriginal && P.clips.includes(op.clip) && JSON.stringify(op.clip) === JSON.stringify(source)) op.clip.mute = true;
      let track = source.track + 1;
      for (const name of op.selected) {
        const output = outputs.find(o => o.stem === name);
        while (track < P.tracks.length && (P.tracks[track].mute || P.clips.some(c => c.track === track && c.t < source.t + source.l && c.t + c.l > source.t))) track++;
        while (P.tracks.length <= track) P.tracks.push({ name: '', mute: false });
        if (!P.tracks[track].name) P.tracks[track].name = t('stem.' + name);
        const ch = JSON.parse(JSON.stringify(op.channel));
        ch.id = nextId(P.channels); ch.name = op.channel.name + ' · ' + t('stem.' + name);
        ch.mute = false;
        ch.inst.path = output.path; ch.inst.sample = output.path.split(/[\\/]/).pop();
        P.channels.push(ch);
        P.clips.push({ ...source, ch: ch.id, p: 0, track, mute: false });
        S.curCh = S.placeCh = ch.id;
        track++;
      }
    });
    toast(t('stem.done', { n: outputs.length }), 'info');
    return true;
  },
};
