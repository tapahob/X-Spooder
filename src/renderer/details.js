'use strict';
// Right-hand panel: picture, description and every relation of the selected topic or item.
(function () {
  const { t } = XS.i18n;
  const Model = XS.Model;

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  const money = (n) => `$${Number(n).toLocaleString('ru-RU')}`;

  class Details {
    constructor(model, root, handlers) {
      this.model = model;
      this.root = root;
      this.handlers = handlers;
      root.addEventListener('click', (ev) => {
        const chip = ev.target.closest('[data-topic]');
        if (chip) { handlers.onOpen(chip.dataset.topic); return; }
        const copy = ev.target.closest('[data-copy]');
        if (copy) {
          navigator.clipboard.writeText(copy.dataset.copy).then(() => {
            const old = copy.textContent;
            copy.textContent = t('copied');
            setTimeout(() => { copy.textContent = old; }, 900);
          });
        }
      });
    }

    show(key) {
      this.key = key;
      this.root.scrollTop = 0;
      if (!key) {
        this.root.replaceChildren(h('div', 'empty', t('emptyDetails')));
        return;
      }
      const id = key.slice(2);
      this.root.replaceChildren(key[0] === 'i' ? this.item(id) : this.topic(id));
    }

    refresh() { this.show(this.key); }

    // --- building blocks ------------------------------------------------------

    chip(id) {
      const m = this.model;
      const topic = m.topics[id];
      const el = h('button', `chip st-${m.status(id)}`);
      const state = m.state(id);
      if (state) el.classList.add(`p-${state}`);
      el.dataset.topic = id;
      el.title = id;
      el.appendChild(XS.sprite(topic.icon, topic.iconKind));
      el.appendChild(h('span', null, m.name(id)));
      return el;
    }

    section(title, cls) {
      const s = h('section', cls);
      s.appendChild(h('h3', null, title));
      return s;
    }

    topicList(title, ids, cls) {
      if (!ids.length) return null;
      const s = this.section(`${title}`, cls);
      s.querySelector('h3').appendChild(h('span', 'count', String(ids.length)));
      const list = h('div', 'chips');
      const sorted = [...new Set(ids)].sort((a, b) => this.model.name(a).localeCompare(this.model.name(b), XS.i18n.locale()));
      for (const id of sorted) list.appendChild(this.chip(id));
      s.appendChild(list);
      return s;
    }

    header(kindLabel, id, ref, kind) {
      const m = this.model;
      const head = h('div', 'head');
      if (ref) {
        const pic = XS.sprite(ref, kind, { full: true }); // the whole picture, not the thumbnail cut
        pic.classList.add('hero');
        head.appendChild(pic);
      }
      head.appendChild(h('div', 'kind', kindLabel));
      head.appendChild(h('h2', null, m.name(id)));
      const idEl = h('button', 'id', id);
      idEl.dataset.copy = id;
      idEl.title = t('copyId');
      head.appendChild(idEl);
      return head;
    }

    article(articleId, withTitle) {
      const a = this.model.data.articles[articleId];
      const text = a && this.model.str(a.text);
      const box = h('div', 'article');
      if (withTitle) box.appendChild(h('h4', null, this.model.name(a.title)));
      if (text && text.trim()) {
        const p = h('div', 'text');
        p.innerHTML = Model.rich(text);
        box.appendChild(p);
      } else if (!withTitle) {
        box.appendChild(h('div', 'text muted', t('noDescription')));
      }
      return box;
    }

    itemRow(id, note) {
      const m = this.model;
      const it = m.items[id];
      const row = h('div', 'item-row');
      row.appendChild(XS.sprite(it ? it.icon : null, 'item'));
      const body = h('div');
      body.appendChild(h('div', 'name', m.name(id)));
      if (note) body.appendChild(h('div', 'muted', note));
      row.appendChild(body);
      return row;
    }

    manufacture(name) {
      const m = this.model;
      const p = m.data.manufacture[name];
      const row = h('div', 'manu');
      row.appendChild(XS.sprite(p.img, 'item'));
      const body = h('div');
      const title = h('div', 'name', m.name(name));
      if (p.category) title.appendChild(h('span', 'muted', ` · ${m.name(p.category)}`));
      body.appendChild(title);
      const needs = Object.entries(p.needs).map(([k, n]) => `${m.name(k)} ×${n}`);
      if (needs.length) body.appendChild(h('div', 'muted', needs.join(', ')));
      row.appendChild(body);
      return row;
    }

    /** Where the topic stands in the loaded save, and what is still missing if it cannot be started. */
    progressNotes(id, note) {
      const m = this.model;
      const state = m.state(id);
      if (state === 'done') { note('p-done', t('stateDone')); return; }
      if (state === 'avail') { note('p-avail', t('stateAvail')); return; }
      if (state === 'active' || state === 'paused') {
        const run = m.progress.active.get(id);
        note('p-active', t(state === 'active' ? 'stateActive' : 'statePaused', run.spent, run.cost, run.base, run.assigned));
        return;
      }
      const b = m.blockers(id);
      if (!b) return;
      if (b.disabled) {
        const by = m.disabledBy(id).map((d) => m.name(d));
        note('p-disabled', by.length ? t('blockedDisabledBy', by.join(', ')) : t('blockedDisabled'));
      }
      if (b.deps.length) {
        const names = b.deps.slice(0, 5).map((d) => m.name(d)).join(', ');
        note('p-blocked', t('blockedDeps', names + (b.deps.length > 5 ? ` … (+${b.deps.length - 5})` : '')));
      }
      if (b.item) note('p-blocked', t('blockedItem'));
      if (b.funcs.length) note('p-blocked', t('blockedFunc', b.funcs.join(', ')));
    }

    // --- topic ----------------------------------------------------------------

    topic(id) {
      const m = this.model;
      const topic = m.topics[id];
      const status = m.status(id);
      const frag = document.createDocumentFragment();

      const art = topic.article && m.data.articles[topic.article];
      const hero = art && art.img ? [art.img, art.kind] : [topic.icon, topic.iconKind];
      const head = this.header(t('topic'), id, hero[0], hero[1]);
      frag.appendChild(head);

      const facts = h('div', 'facts');
      const fact = (label, value, hint) => {
        const f = h('div', 'fact');
        f.appendChild(h('span', 'label', label));
        const v = h('span', 'value', value);
        if (hint) v.title = hint;
        f.appendChild(v);
        facts.appendChild(f);
      };
      if (topic.cost) fact(t('cost'), String(topic.cost), t('costHint'));
      if (topic.points) fact(t('points'), String(topic.points));
      if (topic.section) fact(t('section'), m.name(topic.section));
      if (facts.children.length) frag.appendChild(facts);

      const notes = h('div', 'notes');
      const note = (cls, text) => notes.appendChild(h('div', `note ${cls}`, text));
      if (status === 'locked') note('locked', t('lockedTopic'));
      else if (status === 'auto') note('auto', t('autoTopic'));
      if (m.isStart(id) && topic.cost > 0) note('start', t('startTopic'));
      this.progressNotes(id, note);
      for (const fn of topic.baseFunc) {
        const who = (m.data.funcProviders[fn] || []).map((f) => m.name(f));
        note('func', `${t('baseFunc')}: ${fn}${who.length ? ` (${t('providedBy')}: ${who.slice(0, 4).join(', ')}${who.length > 4 ? '…' : ''})` : ''}`);
      }
      if (notes.children.length) frag.appendChild(notes);

      const btn = h('button', 'primary', t('focus'));
      btn.dataset.topic = id;
      frag.appendChild(btn);

      if (m.hasItem(id)) {
        const s = this.section(t('needsItem'), 'k-item');
        s.appendChild(this.itemRow(id, topic.destroyItem ? t('itemConsumed') : t('itemKept')));
        frag.appendChild(s);
      }

      if (topic.article) frag.appendChild(this.article(topic.article, false));

      const by = (kind, dir) => (dir < 0 ? m.inc[id] : m.out[id]).filter((e) => e.kind === kind);
      const add = (el) => { if (el) frag.appendChild(el); };

      add(this.topicList(t('deps'), by('dep', -1).map((e) => e.from), 'k-dep'));
      add(this.topicList(t('unlockedBy'), by('unlock', -1).map((e) => e.from), 'k-unlock'));
      add(this.topicList(t('freeFrom'), by('free', -1).map((e) => e.from), 'k-free'));
      if (topic.sources.length) {
        const s = this.section(t('sources'), 'k-source');
        const ul = h('ul', 'plain');
        for (const src of topic.sources) {
          const li = h('li', null, m.name(src.id));
          li.prepend(h('span', 'tag', t(`source_${src.kind}`)));
          li.title = src.id;
          ul.appendChild(li);
        }
        s.appendChild(ul);
        frag.appendChild(s);
      }
      add(this.topicList(t('disabledBy'), by('disable', -1).map((e) => e.from), 'k-disable'));

      add(this.topicList(t('leadsTo'), by('dep', 1).map((e) => e.to), 'k-dep'));
      add(this.topicList(t('unlocks'), by('unlock', 1).map((e) => e.to), 'k-unlock'));
      add(this.topicList(t('givesFree'), topic.free, 'k-free'));
      for (const [gate, list] of Object.entries(topic.freeProtected)) {
        add(this.topicList(t('givesFreeIf', m.name(gate)), list, 'k-free'));
      }
      add(this.topicList(t('disables'), by('disable', 1).map((e) => e.to), 'k-disable'));

      if (topic.spawned) {
        const s = this.section(t('spawns'));
        s.appendChild(this.itemRow(topic.spawned, topic.spawnedCount > 1 ? `×${topic.spawnedCount}` : null));
        frag.appendChild(s);
      }
      if (topic.builds.length) {
        const s = this.section(t('builds'));
        s.querySelector('h3').appendChild(h('span', 'count', String(topic.builds.length)));
        for (const name of topic.builds) s.appendChild(this.manufacture(name));
        frag.appendChild(s);
      }
      if (topic.revealed.length) {
        const s = this.section(t('articles'));
        s.querySelector('h3').appendChild(h('span', 'count', String(topic.revealed.length)));
        for (const a of topic.revealed) {
          const art2 = m.data.articles[a];
          const d = h('details', 'reveal');
          const sum = h('summary');
          sum.appendChild(XS.sprite(art2.img, art2.kind));
          sum.appendChild(h('span', null, m.name(art2.title)));
          d.appendChild(sum);
          d.addEventListener('toggle', () => {
            if (d.open && d.children.length === 1) {
              if (art2.img) { const pic = XS.sprite(art2.img, art2.kind, { full: true }); pic.classList.add('hero'); d.appendChild(pic); }
              d.appendChild(this.article(a, false));
            }
          });
          s.appendChild(d);
        }
        frag.appendChild(s);
      }
      return frag;
    }

    // --- item -----------------------------------------------------------------

    item(id) {
      const m = this.model;
      const it = m.items[id];
      const frag = document.createDocumentFragment();
      frag.appendChild(this.header(it.liveAlien ? t('prisoner') : t('item'), id, it.icon, 'item'));

      const facts = h('div', 'facts');
      if (it.costBuy) {
        const f = h('div', 'fact');
        f.append(h('span', 'label', t('buyable')), h('span', 'value', money(it.costBuy)));
        facts.appendChild(f);
      }
      if (it.costSell) {
        const f = h('div', 'fact');
        f.append(h('span', 'label', t('sell')), h('span', 'value', money(it.costSell)));
        facts.appendChild(f);
      }
      if (facts.children.length) frag.appendChild(facts);

      if (!it.costBuy && !it.makers.length) {
        const notes = h('div', 'notes');
        notes.appendChild(h('div', 'note', t('notBuyable')));
        frag.appendChild(notes);
      }

      const s = this.section(t('usedFor'), 'k-item');
      const list = h('div', 'chips');
      list.appendChild(this.chip(id));
      s.appendChild(list);
      s.appendChild(h('div', 'muted', m.topics[id].destroyItem ? t('itemConsumed') : t('itemKept')));
      frag.appendChild(s);

      if (it.costBuy && it.requiresBuy.length) {
        frag.appendChild(this.topicList(t('buyRequires'), it.requiresBuy, 'k-dep'));
      }
      if (it.makers.length) {
        const sec = this.section(t('madeBy'));
        for (const name of it.makers) {
          sec.appendChild(this.manufacture(name));
          const req = m.data.manufacture[name].requires.filter((r) => m.topics[r]);
          if (req.length) {
            const chips = h('div', 'chips indent');
            for (const r of req) chips.appendChild(this.chip(r));
            sec.appendChild(chips);
          }
        }
        frag.appendChild(sec);
      }

      const artId = m.data.articles[id] ? id : m.topics[id].article;
      if (artId) frag.appendChild(this.article(artId, false));
      return frag;
    }
  }

  XS.Details = Details;
})();
