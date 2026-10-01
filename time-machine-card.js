/*
 * time-machine-card
 * A generic "back in time" wrapper. It renders ANY child card, but feeds
 * that child a patched `hass` whose selected entities hold their value
 * AS OF the selected date, so state-reading cards (tile, gauge, glance,
 * entities, markdown, most custom cards) show historical data unmodified.
 *
 *   type: custom:time-machine-card
 *   title: Sleep            # optional header label
 *   entities:               # which entities to rewind (explicit list)
 *     - sensor.frederik_sleep_analyzer_sleep_score
 *     - sensor.frederik_sleep_analyzer_deep_sleep
 *   card:                   # ANY card config (or use `cards:` for a list)
 *     type: tile
 *     entity: sensor.frederik_sleep_analyzer_sleep_score
 *
 * Semantics: "date D" = the entity's state as of the END of day D
 *   (last reading at or before D 23:59, or now if D is today).
 * Source: raw history (recorder retention); falls back to daily
 *   statistics for older dates (shown as "approx.").
 *
 * Limitations (inherent):
 *  - Graph/history cards (history-graph, statistics-graph, mini-graph,
 *    apexcharts) fetch their OWN history window and will NOT follow the
 *    selected date. This wrapper only rewinds current-state.
 *  - On a past date the child is locked (no taps/toggles) so controls
 *    can't act on the live entity. On "today" it is fully interactive.
 */

const VERSION = "1.1.1";

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

class TimeMachineCard extends HTMLElement {
  constructor() {
    super();
    this._selected = startOfDay(new Date());
    this._vals = {};         // entity_id -> {state, lu} for selected past date
    this._approx = false;
    this._child = null;
    this._childReady = null;
    this._lastFetchKey = null;
    this._built = false;
  }

  setConfig(config) {
    if (!config.card && !(config.cards && config.cards.length)) {
      throw new Error("time-machine-card: provide a 'card' (or 'cards') to wrap");
    }
    if (!config.entities || !config.entities.length) {
      throw new Error("time-machine-card: 'entities' list is required (the entities to rewind)");
    }
    this._config = Object.assign({ title: "" }, config);
    this._childConfig = config.card
      ? config.card
      : { type: "vertical-stack", cards: config.cards };
    this._built = false;
    this._child = null;
    this._childReady = null;
    this._lastFetchKey = null;
    this._vals = {};
  }

  getCardSize() {
    if (this._child && this._child.getCardSize) {
      try { return this._child.getCardSize() + 1; } catch (e) { /* noop */ }
    }
    return 6;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) { this._build(); this._built = true; }
    this._tick();
  }

  async _build() {
    const root = document.createElement("ha-card");
    root.className = "tmc-card";
    const style = document.createElement("style");
    style.textContent = this._css();
    root.appendChild(style);

    const header = document.createElement("div");
    header.className = "tmc-header";
    root.appendChild(header);
    this._header = header;

    const wrap = document.createElement("div");
    wrap.className = "tmc-childwrap";
    const slot = document.createElement("div");
    slot.className = "tmc-slot";
    wrap.appendChild(slot);
    const ribbon = document.createElement("div");
    ribbon.className = "tmc-ribbon";
    ribbon.style.display = "none";
    wrap.appendChild(ribbon);
    root.appendChild(wrap);
    this._slot = slot;
    this._ribbon = ribbon;

    this.innerHTML = "";
    this.appendChild(root);

    this._renderHeader();

    // Create the child card (async helper load).
    this._childReady = (async () => {
      try {
        const helpers = await window.loadCardHelpers();
        const el = helpers.createCardElement(this._childConfig);
        if (this._hass) el.hass = this._hass;
        this._slot.appendChild(el);
        this._child = el;
      } catch (e) {
        const err = document.createElement("div");
        err.className = "tmc-error";
        err.textContent = "time-machine-card: failed to create child card: " + (e && e.message ? e.message : e);
        this._slot.appendChild(err);
        // eslint-disable-next-line no-console
        console.error("time-machine-card child error", e);
      }
    })();
  }

  _atToday() { return sameDay(this._selected, startOfDay(new Date())); }

  _tick() {
    const key = this._atToday() ? "today" : this._selected.getTime().toString();
    if (key !== this._lastFetchKey) {
      this._lastFetchKey = key;
      if (this._atToday()) { this._vals = {}; this._approx = false; this._apply(); }
      else this._fetchAsOf(this._selected);
    } else {
      this._apply(); // hass updated; keep patched/live view fresh
    }
    this._renderHeader();
  }

  async _fetchAsOf(date) {
    const hass = this._hass;
    const ids = this._config.entities;
    const start = startOfDay(date);
    let end = addDays(start, 1);
    const now = new Date();
    if (end > now) end = now;

    this._loading = true;
    this._renderHeader();
    const vals = {};
    let approx = false;
    try {
      const hist = await hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: ids,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      let any = false;
      for (const id of ids) {
        const arr = hist && hist[id];
        if (arr && arr.length) {
          const last = arr[arr.length - 1];
          const s = last.s !== undefined ? last.s : last.state;
          const lu = last.lu !== undefined ? last.lu : last.lc;
          vals[id] = { state: s, lu };
          any = true;
        }
      }
      if (!any) {
        // Older than recorder retention: daily statistics.
        const stats = await hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          statistic_ids: ids,
          period: "day",
          types: ["state", "mean", "max"],
        });
        for (const id of ids) {
          const arr = stats && stats[id];
          if (arr && arr.length) {
            const r = arr[arr.length - 1];
            const v = r.state !== undefined && r.state !== null ? r.state
              : (r.mean !== undefined && r.mean !== null ? r.mean : r.max);
            if (v !== undefined && v !== null) { vals[id] = { state: v }; approx = true; }
          }
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("time-machine-card fetch error", e);
    }
    this._vals = vals;
    this._approx = approx;
    this._loading = false;
    this._apply();
    this._renderHeader();
  }

  _patch(hass, vals) {
    const states = Object.assign({}, hass.states);
    for (const [id, v] of Object.entries(vals)) {
      const base = hass.states[id];
      if (!base) continue;
      const luIso = v.lu ? new Date(v.lu * 1000).toISOString() : base.last_updated;
      states[id] = Object.assign({}, base, {
        state: String(v.state),
        last_changed: luIso,
        last_updated: luIso,
      });
    }
    return Object.assign({}, hass, { states });
  }

  async _apply() {
    if (this._childReady) { try { await this._childReady; } catch (e) { /* noop */ } }
    if (!this._child || !this._hass) return;
    if (this._atToday()) {
      this._child.hass = this._hass;           // live & interactive
      this._setLocked(false);
    } else {
      this._child.hass = this._patch(this._hass, this._vals);
      this._setLocked(true);
    }
  }

  _setLocked(locked) {
    if (!this._slot) return;
    this._slot.classList.toggle("tmc-locked", locked);
    if (this._ribbon) this._ribbon.style.display = locked ? "block" : "none";
  }

  _dateLabel() {
    const today = startOfDay(new Date());
    if (sameDay(this._selected, today)) return "Today";
    if (sameDay(this._selected, addDays(today, -1))) return "Yesterday";
    try {
      return this._selected.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    } catch (e) { return this._selected.toDateString(); }
  }

  _renderHeader() {
    if (!this._header) return;
    const atToday = this._atToday();
    const title = this._config.title;
    this._header.innerHTML = `
      ${title ? `<div class="tmc-title"><ha-icon icon="mdi:history"></ha-icon><span>${title}</span></div>` : `<div></div>`}
      <div class="tmc-nav">
        ${this._loading ? `<span class="tmc-loading">...</span>` : ""}
        ${this._approx && !atToday ? `<span class="tmc-approx" title="approximated from long-term statistics">approx.</span>` : ""}
        <button class="tmc-btn" data-nav="prev" title="Previous day"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
        <button class="tmc-date" data-nav="today" title="Jump to today">${this._dateLabel()}</button>
        <button class="tmc-btn" data-nav="next" ${atToday ? "disabled" : ""} title="Next day"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
      </div>`;
    this._header.querySelectorAll("[data-nav]").forEach((el) =>
      el.addEventListener("click", () => this._onNav(el.getAttribute("data-nav"))));
    if (this._ribbon) this._ribbon.textContent = "Viewing " + this._dateLabel() + " - controls locked";
  }

  _onNav(dir) {
    const today = startOfDay(new Date());
    if (dir === "prev") this._selected = addDays(this._selected, -1);
    else if (dir === "next") { const n = addDays(this._selected, 1); if (n <= today) this._selected = n; }
    else if (dir === "today") this._selected = today;
    this._tick();
  }

  _css() {
    return `
      .tmc-card { padding: 10px 10px 4px; }
      .tmc-header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 4px 8px; }
      .tmc-title { display:flex; align-items:center; gap:7px; font-weight:600; color:var(--primary-text-color); }
      .tmc-title ha-icon { --mdc-icon-size:20px; color:var(--primary-color); }
      .tmc-nav { display:flex; align-items:center; gap:6px; }
      .tmc-btn, .tmc-date { background:var(--secondary-background-color); color:var(--primary-text-color);
        border:none; border-radius:9px; cursor:pointer; font:inherit; display:inline-flex; align-items:center; justify-content:center; }
      .tmc-btn { width:32px; height:32px; }
      .tmc-btn ha-icon { --mdc-icon-size:19px; }
      .tmc-btn:disabled { opacity:.35; cursor:default; }
      .tmc-date { padding:0 13px; height:32px; font-weight:600; min-width:96px; }
      .tmc-btn:hover:not(:disabled), .tmc-date:hover { background:var(--divider-color); }
      .tmc-loading, .tmc-approx { font-size:.72rem; color:var(--secondary-text-color); }
      .tmc-approx { font-style:italic; }
      .tmc-childwrap { position:relative; }
      /* Blend the wrapped child: no shadow / border of its own. */
      .tmc-slot { --ha-card-box-shadow: none; --ha-card-border-width: 0px; }
      .tmc-slot.tmc-locked { filter:saturate(.9); }
      .tmc-slot.tmc-locked > * { pointer-events:none; }
      .tmc-ribbon { position:absolute; top:6px; right:6px; background:var(--secondary-background-color);
        color:var(--secondary-text-color); font-size:.68rem; padding:2px 8px; border-radius:8px; opacity:.9; pointer-events:none; }
      .tmc-error { color:var(--error-color,#c0392b); padding:10px; font-size:.85rem; }
    `;
  }
}

customElements.define("time-machine-card", TimeMachineCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "time-machine-card",
  name: "Time Machine Card",
  description: "Wraps any card and rewinds its entities' state to a selected past date.",
  preview: false,
});
// eslint-disable-next-line no-console
console.info(`%c TIME-MACHINE-CARD %c v${VERSION} `, "color:#fff;background:#6a5acd;border-radius:3px 0 0 3px;padding:2px 4px", "color:#6a5acd;background:#263238;border-radius:0 3px 3px 0;padding:2px 4px");
