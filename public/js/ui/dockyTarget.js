import { el } from '../util.js';
import { dockyApi } from '../docky/docky.js';

/**
 * Docky target picker (LOT 5) — replaces the two free-text « Docky agent » /
 * « Docky container » fields of the element form.
 *
 * Behaviour:
 *   - on mount it probes `GET /api/docky/status`; when Docky is configured and
 *     reachable it loads `GET /api/docky/agents`, then
 *     `GET /api/docky/containers?agent=` on selection;
 *   - each dropdown is FILTERABLE (type to narrow) and shows STATUS BADGES
 *     (agent online/offline, container state/health);
 *   - when Docky is unavailable / not configured the two inputs stay EDITABLE
 *     (free-text fallback) with a clear message — never a broken form;
 *   - the stored value is always the container NAME (the stable identity:
 *     Docky `id` changes on recreation — contract §2.2 / Q9).
 *
 * Returns `{ section, getValue, dispose }`.
 */

export function buildDockyTargetField({ element, onChange } = {}) {
  const existingAgent = element?.docky?.agent || '';
  const existingContainer = element?.docky?.container || '';

  const section = el('div', 'docky-target-section');
  section.appendChild(el('div', 'docky-target-title', 'Docky target'));
  section.appendChild(
    el(
      'small',
      'field-help',
      'Link this element to a container for live health, CPU/RAM and start/stop/restart controls. Stored as agent + container NAME (stable across container recreation).'
    )
  );

  const agentField = makeCombo({ placeholder: 'agent (server)' });
  const containerField = makeCombo({ placeholder: 'container name' });
  agentField.setValue(existingAgent);
  containerField.setValue(existingContainer);

  const grid = el('div', 'docky-target-grid');
  const af = el('div', 'field');
  af.appendChild(el('span', 'field-label', 'Agent'));
  af.appendChild(agentField.root);
  const cf = el('div', 'field');
  cf.appendChild(el('span', 'field-label', 'Container'));
  cf.appendChild(containerField.root);
  grid.append(af, cf);
  section.appendChild(grid);

  const statusEl = el('div', 'docky-target-status muted', '');
  section.appendChild(statusEl);

  let disposed = false;
  let available = false;
  let containersReqSeq = 0;

  const setStatus = (message, kind = '') => {
    if (disposed) return;
    statusEl.className = `docky-target-status ${kind}`.trim();
    statusEl.textContent = message;
  };

  async function loadContainers(agent) {
    const seq = ++containersReqSeq;
    if (!agent) {
      containerField.setItems([]);
      return;
    }
    setStatus(`Loading containers for “${agent}”…`);
    try {
      const res = await dockyApi.containers(agent);
      if (disposed || seq !== containersReqSeq) return;
      const containers = Array.isArray(res?.containers) ? res.containers : [];
      containerField.setItems(containers.map(containerItem));
      setStatus(`${containers.length} container${containers.length === 1 ? '' : 's'} on “${agent}”.`, 'success');
    } catch (err) {
      if (disposed || seq !== containersReqSeq) return;
      setStatus(err?.message || 'Failed to load containers', 'error');
    }
  }

  async function init() {
    setStatus('Checking Docky…');
    let status;
    try {
      status = await dockyApi.status();
    } catch {
      status = { configured: false, reachable: false };
    }
    if (disposed) return;
    if (!status?.configured) {
      available = false;
      setStatus('Docky is not configured — enter agent and container manually.', 'warn');
      return;
    }
    if (!status?.reachable) {
      available = false;
      setStatus('Docky is offline — enter agent and container manually.', 'warn');
      return;
    }
    available = true;
    try {
      const res = await dockyApi.agents();
      if (disposed) return;
      const agents = Array.isArray(res?.agents) ? res.agents : [];
      agentField.setItems(agents.map(agentItem));
      setStatus(`${agents.length} agent${agents.length === 1 ? '' : 's'} available.`, 'success');
      // Preload containers for the currently stored agent, if any.
      const current = agentField.getValue();
      if (current) loadContainers(current);
    } catch (err) {
      if (disposed) return;
      available = false;
      setStatus(err?.message || 'Docky is unreachable — enter values manually.', 'warn');
    }
  }

  agentField.onChange((value) => loadContainers(value));
  // Let the caller react to ANY agent/container edit (used by the health
  // section to keep its “Docky target missing” warning live).
  if (typeof onChange === 'function') {
    agentField.onChange(onChange);
    containerField.onChange(onChange);
  }

  init();

  function getValue() {
    const agent = agentField.getValue().trim();
    const container = containerField.getValue().trim();
    return agent || container ? { agent, container } : null;
  }

  return {
    section,
    getValue,
    isAvailable: () => available,
    dispose() {
      disposed = true;
      containersReqSeq += 1;
    },
  };
}

// ---- combobox --------------------------------------------------------------

function makeCombo({ placeholder }) {
  const root = el('div', 'docky-combo');
  const input = el('input', null, null, {
    type: 'text',
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const list = el('div', 'docky-combo-list hidden');
  root.append(input, list);

  let items = [];
  const changeHandlers = [];
  let hideTimer = 0;

  const notify = (value, item) => {
    for (const fn of changeHandlers) {
      try {
        fn(value, item);
      } catch {
        /* a listener must never break the picker */
      }
    }
  };

  const show = () => {
    if (!items.length) return;
    list.classList.remove('hidden');
  };
  const hide = () => list.classList.add('hidden');

  function render() {
    const q = input.value.trim().toLowerCase();
    const filtered = items.filter(
      (it) => !q || it.label.toLowerCase().includes(q) || String(it.search || '').toLowerCase().includes(q)
    );
    list.replaceChildren();
    if (!filtered.length) {
      list.appendChild(el('div', 'docky-combo-empty muted', items.length ? 'No match' : 'No options'));
      return;
    }
    for (const it of filtered) list.appendChild(row(it));
  }

  function row(it) {
    const node = el('div', 'docky-combo-row');
    node.dataset.value = it.label;
    const main = el('span', 'docky-combo-label', it.label);
    node.appendChild(main);
    if (it.sub) node.appendChild(el('span', 'docky-combo-sub muted', it.sub));
    for (const badge of it.badges || []) node.appendChild(badge);
    node.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus, select before blur
      input.value = it.label;
      hide();
      notify(it.label, it);
    });
    return node;
  }

  input.addEventListener('focus', show);
  input.addEventListener('input', () => {
    notify(input.value.trim(), null);
    render();
    show();
  });
  input.addEventListener('blur', () => {
    hideTimer = setTimeout(hide, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
    if (e.key === 'Enter') {
      const first = list.querySelector('.docky-combo-row');
      if (first && !list.classList.contains('hidden')) {
        e.preventDefault();
        input.value = first.dataset.value;
        hide();
        notify(input.value, null);
      }
    }
  });

  return {
    root,
    input,
    setItems(next) {
      items = Array.isArray(next) ? next : [];
      render();
    },
    setValue(value) {
      input.value = value || '';
    },
    getValue() {
      return input.value;
    },
    onChange(fn) {
      if (typeof fn === 'function') changeHandlers.push(fn);
    },
    dispose() {
      if (hideTimer) clearTimeout(hideTimer);
    },
  };
}

// ---- badge builders --------------------------------------------------------

function agentItem(agent) {
  return {
    label: agent.name,
    search: agent.name,
    badges: [statusBadge(agent.status)],
  };
}

function containerItem(container) {
  return {
    label: container.name,
    sub: container.image || '',
    badges: [stateBadge(container.state), healthBadge(container.health)],
  };
}

function statusBadge(status) {
  const cls = status === 'online' ? 'ok' : status === 'offline' ? 'bad' : '';
  return el('span', `badge badge-docky-status ${cls}`.trim(), status || 'unknown');
}

function stateBadge(state) {
  const cls = state === 'running' ? 'ok' : state === 'exited' || state === 'dead' ? 'bad' : '';
  return el('span', `badge badge-docky-state ${cls}`.trim(), state || 'unknown');
}

function healthBadge(health) {
  const cls =
    health === 'healthy' ? 'ok' : health === 'unhealthy' ? 'bad' : health === 'starting' ? 'warn' : '';
  return el('span', `badge badge-docky-health ${cls}`.trim(), health ? `health: ${health}` : 'health: none');
}
