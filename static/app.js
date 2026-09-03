const state = { suppliers: [], map: null, markers: null, tileLayer: null, heatmap: null, radiusCircle: null, density: (window.APP_CONFIG && window.APP_CONFIG.density) || 1.4, lastCalculation: null, userLocation: { latitude: 52.3857023, longitude: -2.2536296 }, userMarker: null, radiusMiles: 0, markerMode: 'type', supplierType: 'all', comparisonSort: 'cheapest_delivered', whatIfDelivery: '', productFilters: { search: '', supplier: '', package_type: '', max_price: '', delivery_known: false } };
const SAVED_ESTIMATES_KEY = 'topsoil-saved-estimates';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function safeLink(url, label) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? `<a class="text-emerald-700 underline" target="_blank" rel="noopener" href="${escapeHtml(parsed.href)}">${escapeHtml(label)}</a>` : '';
  } catch (_) { return ''; }
}

function money(value) { return Number.isFinite(Number(value)) ? `£${Number(value).toFixed(2)}` : '—'; }
function precisionMoney(value) { return Number.isFinite(Number(value)) ? `£${Number(value).toFixed(4)}` : '—'; }
function deliveryBasisLabel(offer) {
  if (offer.delivery_type === 'zone') return `Zone ${escapeHtml(offer.matched_postcode_prefix || '')}`;
  if (offer.delivery_type === 'base') return 'Base delivery';
  return 'Delivery quote required';
}

function confidenceBadge(offer) {
  if (offer.delivery_type === 'zone') return '<span class="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Exact zone</span>';
  if (offer.delivery_type === 'base') return '<span class="inline-flex rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">Base only</span>';
  return '<span class="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Quote needed</span>';
}

function scenarioDeliveredCost(offer, whatIfDelivery, requireActual = false) {
  if (offer.delivered_cost_gbp !== null) return Number(offer.delivered_cost_gbp);
  if (requireActual || !Number.isFinite(whatIfDelivery)) return null;
  return Number(offer.whole_package_cost_gbp) + Number(whatIfDelivery);
}

function sortOffersForComparison(offers, litres, sortBy, whatIfDelivery) {
  const withScenario = offers.map(offer => {
    const scenarioDelivered = scenarioDeliveredCost(offer, whatIfDelivery);
    return {
      ...offer,
      scenario_delivered_cost_gbp: scenarioDelivered,
      scenario_delivered_price_per_litre: Number.isFinite(scenarioDelivered) ? scenarioDelivered / litres : null,
    };
  });
  const rank = value => (value === null || value === undefined || !Number.isFinite(Number(value)) ? Number.POSITIVE_INFINITY : Number(value));
  return withScenario.sort((a, b) => {
    if (sortBy === 'nearest') {
      const distanceDiff = rank(a.distance_miles) - rank(b.distance_miles);
      if (distanceDiff) return distanceDiff;
      return rank(a.scenario_delivered_cost_gbp) - rank(b.scenario_delivered_cost_gbp);
    }
    if (sortBy === 'least_surplus') {
      const surplusDiff = rank(a.surplus_litres) - rank(b.surplus_litres);
      if (surplusDiff) return surplusDiff;
      return rank(a.scenario_delivered_cost_gbp) - rank(b.scenario_delivered_cost_gbp);
    }
    if (sortBy === 'best_delivered_per_litre') {
      const unitDiff = rank(a.scenario_delivered_price_per_litre) - rank(b.scenario_delivered_price_per_litre);
      if (unitDiff) return unitDiff;
      return rank(a.scenario_delivered_cost_gbp) - rank(b.scenario_delivered_cost_gbp);
    }
    const deliveredDiff = rank(a.scenario_delivered_cost_gbp) - rank(b.scenario_delivered_cost_gbp);
    if (deliveredDiff) return deliveredDiff;
    return rank(a.normalised_cost_gbp) - rank(b.normalised_cost_gbp);
  });
}

function notify(message, isError = false) {
  const notice = document.querySelector('#notice');
  if (!notice) { console[isError ? 'error' : 'log'](message); return; }
  notice.textContent = message;
  notice.className = `rounded-lg p-3 text-sm ${isError ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`;
}

function showDialog({ title = 'Notice', message = '', confirmText = 'OK', cancelText = 'Cancel', showCancel = false, showInput = false, defaultValue = '', danger = false }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
    const panel = document.createElement('div');
    panel.style.cssText = `width:min(520px,100%);background:${isDark() ? '#111827' : '#ffffff'};color:${isDark() ? '#e5e7eb' : '#111827'};border:1px solid ${isDark() ? '#374151' : '#e7e5e4'};border-radius:12px;box-shadow:0 20px 40px rgba(0,0,0,0.25);padding:18px;`;
    panel.innerHTML = `
      <h3 style="margin:0 0 8px 0;font-size:1.05rem;font-weight:800;">${escapeHtml(title)}</h3>
      <p style="margin:0 0 14px 0;white-space:pre-wrap;line-height:1.5;">${escapeHtml(message)}</p>
      ${showInput ? `<input id="dialog-input" type="text" value="${escapeHtml(defaultValue)}" style="width:100%;padding:10px;border-radius:8px;border:1px solid ${isDark() ? '#4b5563' : '#d6d3d1'};background:${isDark() ? '#1f2937' : '#fff'};color:inherit;margin-bottom:14px;">` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        ${showCancel ? `<button id="dialog-cancel" type="button" style="padding:8px 12px;border-radius:8px;border:1px solid ${isDark() ? '#4b5563' : '#d6d3d1'};background:transparent;color:inherit;font-weight:700;">${escapeHtml(cancelText)}</button>` : ''}
        <button id="dialog-confirm" type="button" style="padding:8px 12px;border-radius:8px;border:1px solid ${danger ? '#b91c1c' : '#047857'};background:${danger ? '#b91c1c' : '#047857'};color:#fff;font-weight:700;">${escapeHtml(confirmText)}</button>
      </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const input = panel.querySelector('#dialog-input');
    if (input) input.focus();
    const cleanup = result => { overlay.remove(); resolve(result); };
    overlay.addEventListener('click', event => { if (event.target === overlay && showCancel) cleanup({ ok: false, value: null }); });
    panel.querySelector('#dialog-confirm')?.addEventListener('click', () => cleanup({ ok: true, value: input ? input.value : null }));
    panel.querySelector('#dialog-cancel')?.addEventListener('click', () => cleanup({ ok: false, value: null }));
    document.addEventListener('keydown', function onKey(event) {
      if (!document.body.contains(overlay)) { document.removeEventListener('keydown', onKey); return; }
      if (event.key === 'Escape' && showCancel) { document.removeEventListener('keydown', onKey); cleanup({ ok: false, value: null }); }
      if (event.key === 'Enter') { document.removeEventListener('keydown', onKey); cleanup({ ok: true, value: input ? input.value : null }); }
    });
  });
}

async function askConfirm(message, danger = false) {
  const result = await showDialog({ title: 'Please confirm', message, showCancel: true, confirmText: danger ? 'Delete' : 'Confirm', cancelText: 'Cancel', danger });
  return result.ok;
}

async function askPrompt(message, defaultValue = '', title = 'Input') {
  const result = await showDialog({ title, message, showInput: true, defaultValue, showCancel: true, confirmText: 'Save', cancelText: 'Cancel' });
  return result.ok ? result.value : null;
}

function savedEstimates() {
  try { return JSON.parse(localStorage.getItem(SAVED_ESTIMATES_KEY) || '[]'); }
  catch (_) { return []; }
}

function renderSavedEstimates() {
  const container = document.querySelector('#saved-estimates');
  if (!container) return; // DOM may not include this element in some contexts
  const saved = savedEstimates();
  container.innerHTML = saved.length ? saved.map((estimate, index) => `
    <div class="flex items-center justify-between gap-3 rounded-lg bg-stone-100 p-3">
      <button type="button" class="min-w-0 text-left hover:text-emerald-800" data-load-estimate="${index}"><strong>${escapeHtml(estimate.name)}</strong><br><span class="text-stone-500">${escapeHtml(estimate.summary)} · ${escapeHtml(estimate.savedAt)}</span></button>
      <button type="button" class="font-semibold text-stone-500 hover:text-red-700" aria-label="Delete ${escapeHtml(estimate.name)}" data-delete-estimate="${index}">Delete</button>
    </div>`).join('') : '<p class="text-stone-500">No saved estimates yet.</p>';
  container.querySelectorAll('[data-load-estimate]').forEach(button => button.addEventListener('click', () => loadSavedEstimate(Number(button.dataset.loadEstimate))));
  container.querySelectorAll('[data-delete-estimate]').forEach(button => button.addEventListener('click', () => {
    const saved = savedEstimates(); saved.splice(Number(button.dataset.deleteEstimate), 1);
    localStorage.setItem(SAVED_ESTIMATES_KEY, JSON.stringify(saved)); renderSavedEstimates();
  }));
}

function loadSavedEstimate(index) {
  const estimate = savedEstimates()[index];
  if (!estimate) return;
  const form = document.querySelector('#calculator-form');
  for (const [key, value] of Object.entries(estimate.values)) if (form.elements[key]) form.elements[key].value = value;
  form.requestSubmit();
  notify(`Loaded “${estimate.name}”.`);
}

function restartCalculator() {
  const form = document.querySelector('#calculator-form');
  form.reset(); form.elements.unit.value = 'cm'; form.elements.quantity.value = 1;
  state.lastCalculation = null;
  state.comparisonSort = 'cheapest_delivered';
  state.whatIfDelivery = '';
  document.querySelector('#volume-result').textContent = 'Enter dimensions';
  document.querySelector('#estimate-results').replaceChildren();
  document.querySelector('#estimate-results').classList.add('hidden');
  document.querySelector('#cheapest-option')?.classList.add('hidden');
  document.querySelector('#estimate-controls')?.classList.add('hidden');
  const sortSelect = document.querySelector('#estimate-sort');
  if (sortSelect) sortSelect.value = 'cheapest_delivered';
  const whatIfInput = document.querySelector('#what-if-delivery');
  if (whatIfInput) whatIfInput.value = '';
  document.querySelector('#save-estimate').disabled = true;
  document.querySelector('#export-estimate').disabled = true;
  document.querySelector('#print-estimate').disabled = true;
  form.elements.length.focus();
}

function renderEstimateComparison(calculationData) {
  const result = document.querySelector('#estimate-results');
  const cheapestBox = document.querySelector('#cheapest-option');
  const controls = document.querySelector('#estimate-controls');
  if (!result || !cheapestBox || !controls) return;
  const offers = Array.isArray(calculationData?.offers) ? calculationData.offers : [];
  if (!offers.length) {
    cheapestBox.classList.remove('hidden');
    cheapestBox.innerHTML = '<strong>No comparable products are available.</strong>';
    controls.classList.add('hidden');
    result.classList.remove('hidden');
    result.innerHTML = '<p class="text-stone-500">No comparable products are available.</p>';
    return;
  }

  controls.classList.remove('hidden');
  const litres = Number(calculationData.volume_litres || 0);
  const whatIfValue = state.whatIfDelivery === '' ? NaN : Number(state.whatIfDelivery);
  const sortedOffers = sortOffersForComparison(offers, litres, state.comparisonSort, whatIfValue);
  const deliveredCount = calculationData.stats?.delivered_offer_count ?? offers.filter(offer => offer.delivered_cost_gbp !== null).length;
  const quoteOnlyCount = calculationData.stats?.quote_only_count ?? offers.filter(offer => offer.delivered_cost_gbp === null).length;

  const bestDeliveredActual = [...offers].filter(offer => offer.delivered_cost_gbp !== null).sort((a, b) => Number(a.delivered_cost_gbp) - Number(b.delivered_cost_gbp))[0] || null;
  const nearestDelivered = [...offers]
    .filter(offer => offer.delivered_cost_gbp !== null && offer.distance_miles !== null)
    .sort((a, b) => Number(a.distance_miles) - Number(b.distance_miles))[0] || null;
  const lowestSurplus = [...offers].sort((a, b) => Number(a.surplus_litres || 0) - Number(b.surplus_litres || 0))[0] || null;
  const bestScenario = sortedOffers.find(offer => Number.isFinite(offer.scenario_delivered_cost_gbp)) || null;

  cheapestBox.classList.remove('hidden');
  if (bestScenario) {
    const isSimulated = bestScenario.delivered_cost_gbp === null;
    cheapestBox.innerHTML = `<div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-emerald-700">${isSimulated ? 'Best estimated delivered option (what-if)' : 'Cheapest delivered option'}</p>
        <p class="mt-1 text-lg font-bold text-stone-800">${escapeHtml(bestScenario.supplier_name)} · ${escapeHtml(bestScenario.product_name)}</p>
        <p class="mt-1 text-sm text-stone-600">${deliveryBasisLabel(bestScenario)}${bestScenario.distance_miles !== null ? ` · ${bestScenario.distance_miles} mi away` : ''}</p>
      </div>
      <div class="text-right">
        <p class="text-2xl font-extrabold text-emerald-800">${money(bestScenario.scenario_delivered_cost_gbp)}</p>
        <p class="text-xs text-stone-500">${bestScenario.packages_needed} package(s), ${bestScenario.coverage_litres}L total</p>
      </div>
    </div>
    <p class="mt-3 text-xs text-stone-500">Compared ${calculationData.stats?.offer_count ?? offers.length} offer(s): ${deliveredCount} with known delivery and ${quoteOnlyCount} quote-only.</p>`;
  } else {
    cheapestBox.innerHTML = '<strong>No delivered total available yet</strong><br><span class="text-sm text-stone-600">Add a base delivery fee or postcode zone to at least one supplier, or use a what-if delivery value.</span>';
  }

  const bestScenarioDelivered = bestScenario?.scenario_delivered_cost_gbp ?? null;
  const bestNormalised = calculationData.stats?.best_normalised_cost_gbp;
  result.classList.remove('hidden');
  result.innerHTML = `<table class="w-full text-left text-sm">
    <thead class="border-b text-stone-500">
      <tr>
        <th class="p-2">Supplier / product</th>
        <th class="p-2">Pack fit</th>
        <th class="p-2">Unit cost</th>
        <th class="p-2">Delivered estimate</th>
        <th class="p-2">Comparison</th>
      </tr>
    </thead>
    <tbody>
      ${sortedOffers.map(offer => {
        const deliveredDelta = (Number.isFinite(offer.scenario_delivered_cost_gbp) && Number.isFinite(bestScenarioDelivered)) ? Math.max(0, offer.scenario_delivered_cost_gbp - bestScenarioDelivered) : null;
        const normalisedDelta = Number.isFinite(bestNormalised) ? Math.max(0, Number(offer.normalised_cost_gbp) - Number(bestNormalised)) : null;
        const deliveryLabel = deliveryBasisLabel(offer);
        const wasteRatio = litres > 0 ? ((Number(offer.surplus_litres || 0) / litres) * 100) : 0;
        const estimatedWasteValue = Number(offer.surplus_litres || 0) * Number(offer.price_per_litre || 0);
        const badges = [];
        if (bestDeliveredActual && offer.supplier_id === bestDeliveredActual.supplier_id && offer.product_id === bestDeliveredActual.product_id) badges.push('<span class="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Best delivered</span>');
        if (nearestDelivered && offer.supplier_id === nearestDelivered.supplier_id && offer.product_id === nearestDelivered.product_id) badges.push('<span class="inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800">Nearest delivered</span>');
        if (lowestSurplus && offer.supplier_id === lowestSurplus.supplier_id && offer.product_id === lowestSurplus.product_id) badges.push('<span class="inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800">Lowest surplus</span>');
        return `<tr class="border-b align-top">
          <td class="p-2">
            <strong>${escapeHtml(offer.supplier_name)}</strong><br>
            ${escapeHtml(offer.product_name)} (${escapeHtml(offer.package_type)})
            ${offer.quality_tags?.length ? `<br><span class="text-xs text-stone-500">${escapeHtml(offer.quality_tags.join(', '))}</span>` : ''}
            ${badges.length ? `<div class="mt-2 flex flex-wrap gap-1">${badges.join('')}</div>` : ''}
          </td>
          <td class="p-2">${offer.packages_needed} × ${money(offer.package_price_gbp)}<br><span class="text-xs text-stone-500">${offer.coverage_litres}L supplied${offer.surplus_litres > 0 ? ` · ${offer.surplus_litres}L surplus` : ''}</span></td>
          <td class="p-2"><span class="font-semibold">${money(offer.normalised_cost_gbp)}</span><br><span class="text-xs text-stone-500">${precisionMoney(offer.price_per_litre)} / L</span></td>
          <td class="p-2">
            ${Number.isFinite(offer.scenario_delivered_cost_gbp) ? `<span class="font-semibold">${money(offer.scenario_delivered_cost_gbp)}</span>` : `${money(offer.whole_package_cost_gbp)} + quote`}
            <br><span class="text-xs text-stone-500">${deliveryLabel}${offer.delivery_cost_gbp === null ? (Number.isFinite(whatIfValue) ? ` · what-if ${money(whatIfValue)}` : '') : ` · delivery ${money(offer.delivery_cost_gbp)}`}${offer.distance_miles !== null ? ` · ${offer.distance_miles} mi away` : ''}</span>
            <div class="mt-1">${confidenceBadge(offer)}</div>
            <details class="mt-2">
              <summary class="cursor-pointer text-xs font-semibold text-emerald-700">Cost breakdown</summary>
              <div class="mt-1 space-y-1 text-xs text-stone-600">
                <div>Product subtotal: ${money(offer.whole_package_cost_gbp)}</div>
                <div>Delivery: ${offer.delivery_cost_gbp !== null ? money(offer.delivery_cost_gbp) : (Number.isFinite(whatIfValue) ? `${money(whatIfValue)} (what-if)` : 'Quote required')}</div>
                <div>Total delivered: ${Number.isFinite(offer.scenario_delivered_cost_gbp) ? money(offer.scenario_delivered_cost_gbp) : 'Pending quote'}</div>
                <div>Surplus indicator: ${offer.surplus_litres}L (${wasteRatio.toFixed(1)}%) · potential excess value ${money(estimatedWasteValue)}</div>
              </div>
            </details>
          </td>
          <td class="p-2">${deliveredDelta === null ? '<span class="text-xs font-semibold text-amber-700">Awaiting delivery quote</span>' : deliveredDelta === 0 ? '<span class="text-xs font-semibold text-emerald-700">Top ranked</span>' : `<span class="text-xs font-semibold text-stone-700">+${money(deliveredDelta)} vs top ranked</span>`}<br>${normalisedDelta === null ? '' : normalisedDelta === 0 ? '<span class="text-xs text-emerald-700">Best product price</span>' : `<span class="text-xs text-stone-500">+${money(normalisedDelta)} vs best product price</span>`}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  <p class="mt-3 text-xs text-stone-500">Delivered totals are estimated from configured base/zone delivery rules. Quote-only rows can be ranked with the what-if delivery value.</p>`;
}

function exportRowsFromOffers(offers) {
  return offers.map(offer => ({
    supplier: offer.supplier_name,
    product: offer.product_name,
    package_type: offer.package_type,
    package_price_gbp: offer.package_price_gbp ?? '',
    packages_needed: offer.packages_needed,
    coverage_litres: offer.coverage_litres ?? '',
    surplus_litres: offer.surplus_litres ?? '',
    normalised_cost_gbp: offer.normalised_cost_gbp,
    price_per_litre_gbp: offer.price_per_litre ?? '',
    delivery_basis: offer.delivery_type ?? '',
    matched_postcode_prefix: offer.matched_postcode_prefix ?? '',
    delivery_cost_gbp: offer.delivery_cost_gbp ?? '',
    delivered_cost_gbp: offer.delivered_cost_gbp ?? '',
    scenario_delivered_gbp: offer.scenario_delivered_cost_gbp ?? '',
    scenario_delivered_per_litre_gbp: offer.scenario_delivered_price_per_litre ?? '',
    distance_miles: offer.distance_miles ?? '',
    confidence: offer.delivery_type === 'zone' ? 'Exact zone' : offer.delivery_type === 'base' ? 'Base only' : 'Quote needed',
  }));
}

function filteredExportOffers(scope = 'all') {
  if (!state.lastCalculation?.data?.offers?.length) return [];
  const litres = Number(state.lastCalculation.data.volume_litres || 0);
  const whatIfValue = state.whatIfDelivery === '' ? NaN : Number(state.whatIfDelivery);
  const sorted = sortOffersForComparison(state.lastCalculation.data.offers, litres, state.comparisonSort, whatIfValue);
  if (scope === 'top10') return sorted.slice(0, 10);
  if (scope === 'quote_only') return sorted.filter(offer => offer.delivery_type === 'quote');
  if (scope === 'delivery_known') return sorted.filter(offer => offer.delivery_type !== 'quote');
  return sorted;
}

function delimitedFromRows(rows, includeHeaders = true, separator = ',') {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const escapeCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const body = rows.map(row => keys.map(key => escapeCell(row[key])).join(separator));
  return `${includeHeaders ? `${keys.map(escapeCell).join(separator)}\n` : ''}${body.join('\n')}`;
}

function markdownFromRows(rows, includeHeaders = true) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const escapeCell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const header = `| ${keys.map(escapeCell).join(' | ')} |`;
  const divider = `| ${keys.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${keys.map(key => escapeCell(row[key])).join(' | ')} |`);
  return `${includeHeaders ? `${header}\n${divider}\n` : ''}${body.join('\n')}`;
}

function htmlTableFromRows(rows, includeHeaders = true) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const head = includeHeaders ? `<thead><tr>${keys.map(key => `<th>${escapeHtml(key)}</th>`).join('')}</tr></thead>` : '';
  const body = `<tbody>${rows.map(row => `<tr>${keys.map(key => `<td>${escapeHtml(row[key] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Topsoil export</title><style>body{font-family:Arial,sans-serif;padding:16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d6d3d1;padding:6px;text-align:left;font-size:12px}th{background:#f1f5f9}</style></head><body><table>${head}${body}</table></body></html>`;
}

function exportPayloadFromRows(rows, format, includeHeaders) {
  if (!rows.length) return { text: '', mime: 'text/plain' };
  if (format === 'json') return { text: JSON.stringify(rows, null, 2), mime: 'application/json' };
  if (format === 'ndjson') return { text: rows.map(row => JSON.stringify(row)).join('\n'), mime: 'application/x-ndjson' };
  if (format === 'markdown') return { text: markdownFromRows(rows, includeHeaders), mime: 'text/markdown;charset=utf-8' };
  if (format === 'html') return { text: htmlTableFromRows(rows, includeHeaders), mime: 'text/html;charset=utf-8' };
  if (format === 'tsv') return { text: delimitedFromRows(rows, includeHeaders, '\t'), mime: 'text/tab-separated-values;charset=utf-8' };
  return { text: delimitedFromRows(rows, includeHeaders, ','), mime: 'text/csv;charset=utf-8' };
}

function previewSnippet(text, maxLines = 14, maxChars = 3000) {
  const lines = String(text || '').split('\n').slice(0, maxLines).join('\n');
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}\n…` : lines;
}

function currentExportPayload() {
  const format = document.querySelector('#export-format')?.value || 'csv';
  const scope = document.querySelector('#export-scope')?.value || 'all';
  const includeHeaders = !!document.querySelector('#export-include-headers')?.checked;
  const offers = filteredExportOffers(scope);
  const rows = exportRowsFromOffers(offers);
  if (!rows.length) return { format, scope, includeHeaders, rows, text: '', mime: 'text/plain' };
  const payload = exportPayloadFromRows(rows, format, includeHeaders);
  return { format, scope, includeHeaders, rows, text: payload.text, mime: payload.mime };
}

function renderExportPreview() {
  const preview = document.querySelector('#export-preview');
  const meta = document.querySelector('#export-preview-meta');
  if (!preview || !meta) return;
  const payload = currentExportPayload();
  const scopeLabel = document.querySelector('#export-scope')?.selectedOptions?.[0]?.textContent || payload.scope;
  meta.textContent = payload.rows.length ? `${payload.rows.length} row(s) selected · ${scopeLabel} · ${payload.format.toUpperCase()}` : 'No rows available for this export option.';
  preview.textContent = payload.rows.length ? previewSnippet(payload.text) : 'No data to preview.';
}

function openExportModal() {
  if (!state.lastCalculation?.data?.offers?.length) {
    notify('Run a comparison before exporting.', true);
    return;
  }
  const modal = document.querySelector('#export-modal');
  if (!modal) return;
  const format = document.querySelector('#export-format');
  const scope = document.querySelector('#export-scope');
  const filename = document.querySelector('#export-filename');
  const includeHeaders = document.querySelector('#export-include-headers');
  if (format) format.value = 'csv';
  if (scope) scope.value = 'all';
  if (includeHeaders) includeHeaders.checked = true;
  if (filename && !filename.value.trim()) filename.value = 'topsoil-estimate';
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  renderExportPreview();
}

function closeExportModal() {
  const modal = document.querySelector('#export-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function isDark() { return document.body.classList.contains('dark'); }

function setMapTheme() {
  if (!state.map) return;
  if (state.tileLayer) state.map.removeLayer(state.tileLayer);
  state.tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors &copy; CARTO', subdomains: 'abcd' });
  let reportedError = false;
  state.tileLayer.on('tileerror', () => {
    if (!reportedError) { notify('Map tiles could not be loaded. Check your internet connection or firewall.', true); reportedError = true; }
  });
  state.tileLayer.addTo(state.map);
}

function mapOrigin() {
  return [Number(state.userLocation.latitude), Number(state.userLocation.longitude)];
}

function markerColour(supplier, points) {
  if (supplier.supplier_type === 'shop') return '#2563eb';
  if (supplier.supplier_type === 'supplier') return '#047857';
  return '#6b7280';
}

function distanceMiles([lat1, lon1], [lat2, lon2]) {
  const radians = value => value * Math.PI / 180;
  const deltaLat = radians(lat2 - lat1), deltaLon = radians(lon2 - lon1);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  const button = document.querySelector('#theme-toggle');
  if (button) {
    button.querySelector('.theme-toggle-thumb')?.classList.toggle('is-dark', dark);
    button.querySelector('.hidden')?.replaceChildren(document.createTextNode(dark ? 'Light' : 'Dark'));
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  }
  localStorage.setItem('topsoil-theme', dark ? 'dark' : 'light');
  setMapTheme();
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

function popupContent(supplier) {
  const products = Array.isArray(supplier.products) ? supplier.products : [];
  const productItems = products.length ? products.map(product => `
    <li class="mb-2"><strong>${escapeHtml(product.name)}</strong><br>
    ${escapeHtml(product.package_type)} · ${money(product.price_gbp)}<br>
    <span class="text-sm">${precisionMoney(product.price_per_litre)}/L · ${precisionMoney(product.price_per_kg)}/kg</span></li>`).join('') : '<li>No products added yet.</li>';
  return `<div><strong>${escapeHtml(supplier.name)}</strong><br><span>${escapeHtml(supplier.address || '')}</span><ul class="mt-2">${productItems}</ul><p class="mt-2 text-sm"><strong>Delivery:</strong> ${escapeHtml(supplier.delivery_options || 'Not specified')}</p>${safeLink(supplier.website_url, 'Website')}</div>`;
}

function renderMap() {
  if (!state.map || !state.markers) return;
  state.markers.clearLayers();
  const points = [];
  const origin = mapOrigin();
  const radius = Number(state.radiusMiles);
  const visibleSuppliers = state.suppliers.filter(supplier => {
    const distance = distanceMiles(origin, [Number(supplier.latitude), Number(supplier.longitude)]);
    return (state.supplierType === 'all' || supplier.supplier_type === state.supplierType) && (!radius || distance <= radius);
  });
  const markerLayer = window.L && L.markerClusterGroup ? L.markerClusterGroup() : state.markers;
  visibleSuppliers.forEach(supplier => {
    const lat = Number(supplier.latitude), lng = Number(supplier.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    points.push([lat, lng]);
    const markerIcon = L.divIcon({ className: `supplier-marker supplier-marker-${supplier.supplier_type}`, html: `<span aria-hidden="true" style="background:${markerColour(supplier, points)}"></span>`, iconSize: [28, 36], iconAnchor: [14, 36], popupAnchor: [0, -250] });
    L.marker([lat, lng], { icon: markerIcon, title: supplier.name, alt: supplier.name }).bindPopup(popupContent(supplier)).addTo(markerLayer);
  });
  if (markerLayer !== state.markers) state.markers.addLayer(markerLayer);
  if (state.radiusCircle) state.map.removeLayer(state.radiusCircle);
  if (radius) state.radiusCircle = L.circle(origin, { radius: radius * 1609.344, color: '#2563eb', fillColor: '#60a5fa', fillOpacity: .08, weight: 2 }).addTo(state.map);
  if (state.heatmap) state.map.removeLayer(state.heatmap);
  if (document.querySelector('#heatmap-toggle')?.checked && L.heatLayer) state.heatmap = L.heatLayer(points.map(point => [...point, 0.7]), { radius: 28, blur: 20, maxZoom: 12 }).addTo(state.map);
  if (points.length > 1) state.map.fitBounds(points, { padding: [30, 30], maxZoom: 12 });
  state.map.invalidateSize();
  document.querySelector('#map-status').textContent = visibleSuppliers.length ? `Showing ${visibleSuppliers.length} supplier location${visibleSuppliers.length === 1 ? '' : 's'}${radius ? ` within ${radius} miles` : ''}. Shops are blue; bulk suppliers are green.` : 'No suppliers match this radius.';
}

function renderSupplierChoices() {
  const select = document.querySelector('#supplier-select');
  const previous = select.value;
  select.innerHTML = '<option value="">Choose a supplier</option>' + state.suppliers
    .map(supplier => `<option value="${escapeHtml(supplier.id)}">${escapeHtml(supplier.name)}</option>`).join('');
  select.value = previous;
}

function renderSupplierList() {
  const list = document.querySelector('#supplier-list');
  const shopList = document.querySelector('#shop-list');
  const renderRows = suppliers => suppliers.length ? suppliers.map(supplier => `
    <div class="flex items-center justify-between gap-3 rounded-lg bg-stone-100 p-3">
      <div class="min-w-0"><strong>${escapeHtml(supplier.name)}</strong><br><span class="text-stone-500">${supplier.products.length} product${supplier.products.length === 1 ? '' : 's'}</span></div>
      <div class="flex shrink-0 gap-3"><button type="button" class="font-semibold text-emerald-700 hover:text-emerald-900" data-edit-saved-supplier="${escapeHtml(supplier.id)}">Edit</button><button type="button" class="font-semibold text-red-700 hover:text-red-900" data-delete-saved-supplier="${escapeHtml(supplier.id)}">Delete</button></div>
    </div>`).join('') : '<p class="text-stone-500">No suppliers have been added.</p>';
  if (list) list.innerHTML = renderRows(state.suppliers.filter(supplier => supplier.supplier_type === 'supplier'));
  if (shopList) shopList.innerHTML = renderRows(state.suppliers.filter(supplier => supplier.supplier_type === 'shop')).replace('No suppliers have been added.', 'No shops have been added.');
  document.querySelectorAll('[data-edit-saved-supplier]').forEach(button => button.addEventListener('click', () => editSupplier(button.dataset.editSavedSupplier)));
  document.querySelectorAll('[data-delete-saved-supplier]').forEach(button => button.addEventListener('click', async () => {
    const supplier = state.suppliers.find(item => item.id === button.dataset.deleteSavedSupplier);
    if (!supplier || !await askConfirm(`Delete ${supplier.name} and all its products? This action cannot be undone.`, true)) return;
    try {
      await api(`/api/suppliers/${encodeURIComponent(supplier.id)}`, { method: 'DELETE' });
      resetSupplierForm(); await loadSuppliers(); notify('Supplier deleted.');
    } catch (error) { notify(error.message, true); }
  }));
}

function editProduct(supplierId, productId) {
  const supplier = state.suppliers.find(item => item.id === supplierId);
  const product = supplier?.products.find(item => item.id === productId);
  if (!product) return;
  const form = document.querySelector('#product-form');
  form.elements.supplier_id.value = supplierId;
  for (const key of ['name', 'package_type', 'package_class', 'volume_litres', 'weight_kg', 'price_gbp', 'product_url']) form.elements[key].value = product[key] ?? '';
  let hidden = form.querySelector('[name="product_id"]');
  if (!hidden) { hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = 'product_id'; form.append(hidden); }
  hidden.value = productId;
  form.querySelector('button').textContent = 'Update product';
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function editSupplier(supplierId) {
  const supplier = state.suppliers.find(item => item.id === supplierId);
  if (!supplier) return;
  const form = document.querySelector('#supplier-form');
  for (const key of ['name', 'supplier_type', 'address', 'latitude', 'longitude', 'website_url', 'delivery_options', 'delivery_base_gbp']) form.elements[key].value = supplier[key] ?? '';
  form.elements.delivery_zones.value = (supplier.delivery_zones || []).map(zone => `${zone.postcode_prefix}:${zone.cost_gbp}`).join('\n');
  let hidden = form.querySelector('[name="supplier_id"]');
  if (!hidden) { hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = 'supplier_id'; form.append(hidden); }
  hidden.value = supplierId;
  document.querySelector('#supplier-form-title').textContent = `Edit ${supplier.name}`;
  document.querySelector('#supplier-submit').textContent = 'Update supplier';
  document.querySelector('#cancel-supplier-edit').classList.remove('hidden');
  const deleteBtn = document.querySelector('#delete-supplier'); if (deleteBtn) deleteBtn.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetSupplierForm() {
  const form = document.querySelector('#supplier-form'); form.reset(); form.querySelector('[name="supplier_id"]')?.remove();
  document.querySelector('#supplier-form-title').textContent = 'Add a supplier';
  document.querySelector('#supplier-submit').textContent = 'Save supplier';
  document.querySelector('#cancel-supplier-edit').classList.add('hidden');
  const deleteBtn = document.querySelector('#delete-supplier'); if (deleteBtn) deleteBtn.classList.add('hidden');
}

function renderProducts() {
  const list = document.querySelector('#product-list');
  const filters = state.productFilters;
  const search = String(filters.search || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const maxPrice = Number(filters.max_price);
  const products = state.suppliers.flatMap(supplier => supplier.products.map(product => ({ supplier, product }))).filter(({ supplier, product }) => {
    const searchable = `${supplier.name} ${product.name} ${product.package_type}`.toLowerCase();
    const deliveryKnown = supplier.delivery_base_gbp !== null || supplier.delivery_zones?.length;
    return (!search || searchable.includes(search)) && (!filters.supplier || supplier.id === filters.supplier) && (!filters.package_type || product.package_type === filters.package_type) && (!filters.max_price || (Number.isFinite(maxPrice) && product.price_per_litre !== null && product.price_per_litre <= maxPrice)) && (!filters.delivery_known || deliveryKnown);
  });
  list.innerHTML = products.length ? products.map(({ supplier, product }) => `
    <article class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-stone-200">
      <div class="flex items-start justify-between gap-3"><div><h3 class="font-bold">${escapeHtml(product.name)}</h3><p class="text-sm text-stone-500">${escapeHtml(supplier.name)} · ${escapeHtml(product.package_type)}</p></div><span class="font-bold text-emerald-800">${money(product.price_gbp)}</span></div>
      <dl class="mt-3 grid grid-cols-2 gap-2 text-sm"><div class="rounded bg-stone-100 p-2"><dt class="text-stone-500">Per litre</dt><dd class="font-semibold">${product.price_per_litre === null ? '—' : precisionMoney(product.price_per_litre)}</dd></div><div class="rounded bg-stone-100 p-2"><dt class="text-stone-500">Per kg</dt><dd class="font-semibold">${product.price_per_kg === null ? '—' : precisionMoney(product.price_per_kg)}</dd></div></dl>
      <p class="mt-3 text-xs text-stone-500">${product.effective_volume_litres} L · ${product.effective_weight_kg} kg${product.volume_inferred || product.weight_inferred ? ' (one measure estimated using density)' : ''}</p>
      <div class="mt-3 flex justify-between text-sm">${safeLink(product.product_url, 'Source page')}<span class="flex gap-3"><button class="font-semibold text-emerald-700 hover:text-emerald-900" data-edit-supplier="${escapeHtml(supplier.id)}">Supplier</button><button class="font-semibold text-emerald-700 hover:text-emerald-900" data-supplier-id="${escapeHtml(supplier.id)}" data-product-id="${escapeHtml(product.id)}">Edit</button><button class="font-semibold text-red-700 hover:text-red-900" data-delete-product data-supplier-id="${escapeHtml(supplier.id)}" data-product-id="${escapeHtml(product.id)}">Delete</button></span></div>
    </article>`).join('') : '<p class="text-stone-500">No products match your current filters.</p>';
  list.querySelectorAll('[data-product-id]').forEach(button => button.addEventListener('click', () => editProduct(button.dataset.supplierId, button.dataset.productId)));
  list.querySelectorAll('[data-edit-supplier]').forEach(button => button.addEventListener('click', () => editSupplier(button.dataset.editSupplier)));
  list.querySelectorAll('[data-delete-product]').forEach(button => button.addEventListener('click', async () => {
    if (!await askConfirm('Delete this product? This action cannot be undone.', true)) return;
    try {
      await api(`/api/suppliers/${encodeURIComponent(button.dataset.supplierId)}/products/${encodeURIComponent(button.dataset.productId)}`, { method: 'DELETE' });
      await loadSuppliers(); notify('Product deleted.');
    } catch (error) { notify(error.message, true); }
  }));
}

function renderProductFilters() {
  const form = document.querySelector('#product-filters');
  if (!form) return;
  const supplierSelect = form.elements.supplier;
  const packageSelect = form.elements.package_type;
  const suppliers = state.suppliers.filter(supplier => supplier.products.length);
  const packageTypes = [...new Set(state.suppliers.flatMap(supplier => supplier.products.map(product => product.package_type)))].sort();
  supplierSelect.innerHTML = '<option value="">All suppliers</option>' + suppliers.map(supplier => `<option value="${escapeHtml(supplier.id)}">${escapeHtml(supplier.name)}</option>`).join('');
  packageSelect.innerHTML = '<option value="">All package types</option>' + packageTypes.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
  supplierSelect.value = state.productFilters.supplier;
  packageSelect.value = state.productFilters.package_type;
  form.elements.search.value = state.productFilters.search;
  form.elements.max_price.value = state.productFilters.max_price;
  form.elements.delivery_known.checked = state.productFilters.delivery_known;
}

async function loadSuppliers() {
  const data = await api('/api/suppliers');
  state.suppliers = data.suppliers;
  state.density = data.density_kg_per_litre;
  renderSupplierChoices(); renderSupplierList(); renderProductFilters(); renderProducts(); renderMap();
}

async function loadReviewQueue() {
  const queue = document.querySelector('#review-queue');
  if (!queue) { console.warn('Review queue element not found'); return; }
  try {
    const data = await api('/api/pending-updates');
    const updates = data.updates.filter(item => item.status === 'review');
    queue.innerHTML = updates.length ? updates.map(item => `<article class="rounded-lg bg-stone-100 p-3"><div class="flex justify-between gap-2"><strong>${escapeHtml(item.supplier_id)}</strong><span class="font-semibold">${money(item.old_price_gbp)} → ${money(item.candidate_price_gbp)}</span></div><p class="mt-1 text-xs text-stone-500">${item.difference_percent}% change · ${escapeHtml(item.checked_at)}</p><div class="mt-3 flex items-center gap-3">${safeLink(item.url, 'Check source')}<button class="font-semibold text-emerald-700" data-approve="${escapeHtml(item.id)}">Approve</button><button class="font-semibold text-red-700" data-reject="${escapeHtml(item.id)}">Reject</button></div></article>`).join('') : '<p class="text-stone-500">No price changes waiting for review.</p>';
    queue.querySelectorAll('[data-approve]').forEach(button => button.addEventListener('click', async () => { try { await api(`/api/pending-updates/${button.dataset.approve}/apply`, { method: 'POST' }); await Promise.all([loadReviewQueue(), loadSuppliers()]); notify('Price update applied and recorded in history.'); } catch (error) { notify(error.message, true); } }));
    queue.querySelectorAll('[data-reject]').forEach(button => button.addEventListener('click', async () => { try { await api(`/api/pending-updates/${button.dataset.reject}/reject`, { method: 'POST' }); await loadReviewQueue(); notify('Candidate rejected.'); } catch (error) { notify(error.message, true); } }));
  } catch (error) {
    if (queue) queue.innerHTML = '<p class="text-red-700">Could not load review queue.</p>';
    else console.error('Could not load review queue:', error);
  }
}

function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }

function setupSettings() {
  const toggle = document.querySelector('#settings-toggle');
  const panel = document.querySelector('#settings-panel');
  const close = document.querySelector('#settings-close');
  const fileInput = document.querySelector('#supplier-import-file');
  const fileName = document.querySelector('#supplier-import-file-name');
  const preview = document.querySelector('#supplier-import-preview');
  const status = document.querySelector('#supplier-import-status');
  const historyList = document.querySelector('#import-history');
  const importButton = document.querySelector('#import-suppliers');
  if (!toggle || !panel || !fileInput || !importButton) return;
  const setOpen = open => { panel.classList.toggle('hidden', !open); toggle.setAttribute('aria-expanded', String(open)); };
  toggle.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
  close?.addEventListener('click', () => setOpen(false));
  const setStatus = (message, isError = false) => { status.textContent = message; status.className = `mt-3 rounded-lg p-3 text-xs ${isError ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`; };
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileName.textContent = file ? file.name : 'No file selected'; importButton.disabled = !file; status.classList.add('hidden');
    if (!file) { preview.textContent = 'Choose a file to preview its supplier rows.'; return; }
    try {
      const text = await file.text();
      const rows = file.name.toLowerCase().endsWith('.json') ? (JSON.parse(text).suppliers || JSON.parse(text)) : text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).slice(1);
      const rowCount = Array.isArray(rows) ? rows.length : 0;
      preview.textContent = `Ready to import all ${rowCount} supplier row${rowCount === 1 ? '' : 's'} from ${file.name}. Existing names will be skipped and reported; new rows will still be added.`;
    } catch (error) { preview.textContent = 'This file cannot be previewed as valid JSON or delimited text.'; setStatus(`File check failed: ${error.message}`, true); importButton.disabled = true; }
  });
  document.querySelector('#download-supplier-template')?.addEventListener('click', () => {
    const csv = 'name,supplier_type,address,latitude,longitude,website_url,delivery_options,delivery_base_gbp\nExample Supplier,supplier,,52.0000000,-2.0000000,https://example.com,Delivery details,25.00\n';
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = 'supplier-import-template.csv'; link.click(); URL.revokeObjectURL(link.href);
  });
  document.querySelector('#download-backup')?.addEventListener('click', () => { window.location.href = '/api/suppliers/backup'; setStatus('Shared supplier backup download started.'); });
  document.querySelector('#refresh-import-history')?.addEventListener('click', async () => {
    try {
      const data = await api('/api/suppliers/import-history');
      historyList.classList.remove('hidden');
      historyList.innerHTML = data.imports.length ? data.imports.map(item => `<div class="rounded-lg bg-stone-100 p-2"><div class="flex justify-between gap-2"><span>${escapeHtml(item.names.join(', '))}</span><span>${escapeHtml(item.created_at)}</span></div>${item.undone_at ? '<span>Undone</span>' : `<button type="button" class="mt-1 font-semibold text-red-700" data-undo-import="${escapeHtml(item.id)}">Undo import</button>`}</div>`).join('') : '<p class="text-stone-500">No imports recorded.</p>';
      historyList.querySelectorAll('[data-undo-import]').forEach(button => button.addEventListener('click', async () => { try { const result = await api(`/api/suppliers/import-history/${encodeURIComponent(button.dataset.undoImport)}/undo`, { method: 'POST' }); await loadSuppliers(); setStatus(`Undid import: ${result.names.join(', ')}.`); document.querySelector('#refresh-import-history').click(); } catch (error) { setStatus(error.message, true); } }));
    } catch (error) { setStatus(error.message, true); }
  });
  importButton.addEventListener('click', async () => {
    const file = fileInput.files[0]; if (!file) return;
    importButton.disabled = true; importButton.textContent = 'Importing...';
    try {
      const response = await fetch('/api/suppliers/import', { method: 'POST', body: (() => { const data = new FormData(); data.append('file', file); return data; })() });
      const body = await response.json();
      if (!response.ok) throw new Error([body.error, ...(body.details || [])].filter(Boolean).join(' '));
      await loadSuppliers(); const names = body.suppliers.map(supplier => supplier.name).join(', '); const skipped = body.skipped?.length ? ` Skipped existing: ${body.skipped.map(item => typeof item === 'string' ? item : `${item.name} (${item.reason})`).join(', ')}.` : ''; const message = `${body.imported} supplier${body.imported === 1 ? '' : 's'} imported to the shared site database${names ? `: ${names}.` : '.'}${skipped}`; setStatus(message); notify(message); fileInput.value = ''; fileName.textContent = 'No file selected'; preview.textContent = 'Import complete. Choose another file to import more.';
    } catch (error) { setStatus(error.message, true); notify(error.message, true); }
    finally { importButton.disabled = !fileInput.files.length; importButton.textContent = 'Import suppliers'; }
  });
}

async function findAddress(address, moveMap = true) {
  const place = await api('/api/geocode', { method: 'POST', body: JSON.stringify({ address }) });
  state.userLocation = place;
  renderMap();
  if (moveMap && state.map) {
    if (state.userMarker) state.map.removeLayer(state.userMarker);
    state.userMarker = L.circleMarker([place.latitude, place.longitude], { radius: 9, color: '#2563eb', fillColor: '#60a5fa', fillOpacity: .9 }).bindPopup(`Your location: ${escapeHtml(place.display_name)}`).addTo(state.map);
    state.map.setView([place.latitude, place.longitude], 12); state.userMarker.openPopup();
  }
  return place;
}

document.addEventListener('DOMContentLoaded', () => {
  setupSettings();
  const productFilters = document.querySelector('#product-filters');
  const onProductFilterChanged = event => {
    state.productFilters[event.target.name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    renderProducts();
  };
  if (productFilters) {
    productFilters.addEventListener('input', onProductFilterChanged);
    productFilters.addEventListener('change', onProductFilterChanged);
  }

  document.querySelector('#supplier-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, data = formObject(form), supplierId = data.supplier_id;
    try {
      if ((!data.latitude || !data.longitude) && data.address?.trim()) {
        const place = await findAddress(data.address, false);
        data.latitude = place.latitude;
        data.longitude = place.longitude;
      }
      await api(supplierId ? `/api/suppliers/${encodeURIComponent(supplierId)}` : '/api/suppliers', { method: supplierId ? 'PUT' : 'POST', body: JSON.stringify(data) });
      resetSupplierForm(); await loadSuppliers(); notify(supplierId ? 'Supplier updated.' : 'Supplier saved.');
    } catch (error) { notify(error.message, true); }
  });

  const cancelBtn = document.querySelector('#cancel-supplier-edit'); if (cancelBtn) cancelBtn.addEventListener('click', resetSupplierForm);

  const geocodeBtn = document.querySelector('#supplier-geocode'); if (geocodeBtn) geocodeBtn.addEventListener('click', async () => {
    const form = document.querySelector('#supplier-form');
    try { const place = await findAddress(form.elements.address.value, false); form.elements.latitude.value = place.latitude; form.elements.longitude.value = place.longitude; notify('Coordinates found; save the supplier when ready.'); }
    catch (error) { notify(error.message, true); }
  });

  const mapAddressForm = document.querySelector('#map-address-form'); if (mapAddressForm) mapAddressForm.addEventListener('submit', async event => {
    event.preventDefault();
    try { await findAddress(formObject(event.currentTarget).address); notify('Map centred on the requested address.'); }
    catch (error) { notify(error.message, true); }
  });

  const mapRadius = document.querySelector('#map-radius'); if (mapRadius) mapRadius.addEventListener('change', event => { state.radiusMiles = Number(event.target.value); renderMap(); });
  const markerMode = document.querySelector('#marker-mode'); if (markerMode) markerMode.addEventListener('change', event => { state.markerMode = event.target.value; renderMap(); });
  const supplierTypeFilter = document.querySelector('#supplier-type-filter'); if (supplierTypeFilter) supplierTypeFilter.addEventListener('change', event => { state.supplierType = event.target.value; renderMap(); });
  const heatmapToggle = document.querySelector('#heatmap-toggle'); if (heatmapToggle) heatmapToggle.addEventListener('change', renderMap);

  const productForm = document.querySelector('#product-form'); if (productForm) productForm.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, data = formObject(form), productId = data.product_id;
    try {
      const url = productId ? `/api/suppliers/${encodeURIComponent(data.supplier_id)}/products/${encodeURIComponent(productId)}` : `/api/suppliers/${encodeURIComponent(data.supplier_id)}/products`;
      await api(url, { method: productId ? 'PUT' : 'POST', body: JSON.stringify(data) });
      form.reset(); form.elements.volume_litres.value = 0; form.elements.weight_kg.value = 0;
      form.querySelector('[name="product_id"]')?.remove(); form.querySelector('button').textContent = 'Save product';
      await loadSuppliers(); notify(productId ? 'Product updated.' : 'Product saved.');
    } catch (error) { notify(error.message, true); }
  });

  const calculatorForm = document.querySelector('#calculator-form'); if (calculatorForm) calculatorForm.addEventListener('submit', async event => {
    event.preventDefault();
    const values = formObject(event.currentTarget);
    const litresPerCubicUnit = { cm: 0.001, m: 1000, ft: 28.316846592, in: 0.016387064 };
    const quantity = Number(values.quantity);
    const litres = Number(values.length) * Number(values.width) * Number(values.depth) * quantity * litresPerCubicUnit[values.unit];
    if (!Number.isFinite(litres) || litres <= 0) return notify('Enter three dimensions greater than zero.', true);
    try {
      const address = values.delivery_address?.trim();
      if (address) await findAddress(address, false);
      const data = await api('/api/calculate', { method: 'POST', body: JSON.stringify({ volume_litres: litres, postcode: address || '', location: state.userLocation }) });
      document.querySelector('#volume-result').textContent = `${data.volume_litres.toFixed(1)} L / ${data.weight_kg.toFixed(1)} kg required`;
      state.lastCalculation = { values, data };
      renderEstimateComparison(data);
      document.querySelector('#save-estimate').disabled = false;
      document.querySelector('#export-estimate').disabled = false;
      document.querySelector('#print-estimate').disabled = false;
    } catch (error) { notify(error.message, true); }
  });

  const reloadBtn = document.querySelector('#reload-button'); if (reloadBtn) reloadBtn.addEventListener('click', () => loadSuppliers().then(() => notify('Data refreshed.')).catch(error => notify(error.message, true)));
  const refreshReviewsBtn = document.querySelector('#refresh-reviews'); if (refreshReviewsBtn) refreshReviewsBtn.addEventListener('click', loadReviewQueue);
  const themeToggleBtn = document.querySelector('#theme-toggle'); if (themeToggleBtn) themeToggleBtn.addEventListener('click', () => applyTheme(!isDark()));
  const restartCalculatorBtn = document.querySelector('#restart-calculator'); if (restartCalculatorBtn) restartCalculatorBtn.addEventListener('click', restartCalculator);
  const sortSelect = document.querySelector('#estimate-sort');
  if (sortSelect) {
    sortSelect.value = state.comparisonSort;
    sortSelect.addEventListener('change', event => {
      state.comparisonSort = event.target.value;
      if (state.lastCalculation) renderEstimateComparison(state.lastCalculation.data);
    });
  }
  const whatIfInput = document.querySelector('#what-if-delivery');
  if (whatIfInput) {
    whatIfInput.addEventListener('input', event => {
      state.whatIfDelivery = event.target.value.trim();
      if (state.lastCalculation) renderEstimateComparison(state.lastCalculation.data);
    });
  }
  const saveEstimateBtn = document.querySelector('#save-estimate'); if (saveEstimateBtn) saveEstimateBtn.addEventListener('click', async () => {
    if (!state.lastCalculation) return;
    const defaultName = `Planter estimate — ${state.lastCalculation.data.volume_litres.toFixed(0)} L`;
    const name = await askPrompt('Name this estimate:', defaultName, 'Save estimate');
    if (name === null) return;
    const saved = savedEstimates();
    saved.unshift({ name: name.trim() || defaultName, values: state.lastCalculation.values, summary: `${state.lastCalculation.data.volume_litres.toFixed(1)} L / ${state.lastCalculation.data.weight_kg.toFixed(1)} kg`, savedAt: new Date().toLocaleString() });
    localStorage.setItem(SAVED_ESTIMATES_KEY, JSON.stringify(saved));
    renderSavedEstimates(); notify('Estimate saved in this browser.');
  });
  const clearSavedBtn = document.querySelector('#clear-saved-estimates'); if (clearSavedBtn) clearSavedBtn.addEventListener('click', async () => {
    if (savedEstimates().length && await askConfirm('Delete all saved estimates from this browser?', true)) {
      localStorage.removeItem(SAVED_ESTIMATES_KEY); renderSavedEstimates(); notify('Saved estimates cleared.');
    }
  });

  const deleteSupplierBtn = document.querySelector('#delete-supplier'); if (deleteSupplierBtn) deleteSupplierBtn.addEventListener('click', async () => {
    const hidden = document.querySelector('[name="supplier_id"]');
    if (!hidden) return;
    if (!await askConfirm('Delete this supplier and all its products? This action cannot be undone.', true)) return;
    try {
      await api(`/api/suppliers/${encodeURIComponent(hidden.value)}`, { method: 'DELETE' });
      resetSupplierForm(); await loadSuppliers(); notify('Supplier deleted.');
    } catch (error) { notify(error.message, true); }
  });
  const exportEstimateBtn = document.querySelector('#export-estimate'); if (exportEstimateBtn) exportEstimateBtn.addEventListener('click', openExportModal);
  const exportModal = document.querySelector('#export-modal');
  if (exportModal) exportModal.addEventListener('click', event => { if (event.target === exportModal) closeExportModal(); });
  document.querySelector('#export-modal-close')?.addEventListener('click', closeExportModal);
  document.querySelector('#export-modal-cancel')?.addEventListener('click', closeExportModal);
  document.querySelector('#export-format')?.addEventListener('change', renderExportPreview);
  document.querySelector('#export-scope')?.addEventListener('change', renderExportPreview);
  document.querySelector('#export-include-headers')?.addEventListener('change', renderExportPreview);
  document.querySelector('#export-modal-download')?.addEventListener('click', () => {
    const payload = currentExportPayload();
    if (!payload.rows.length) {
      notify('No rows available to export for this option.', true);
      return;
    }
    const filenameInput = document.querySelector('#export-filename');
    const base = (filenameInput?.value || 'topsoil-estimate').trim().replace(/[\\/:*?"<>|]+/g, '-');
    const extension = ({ json: 'json', tsv: 'tsv', csv: 'csv', ndjson: 'ndjson', markdown: 'md', html: 'html' }[payload.format] || 'txt');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([payload.text], { type: payload.mime }));
    link.download = `${base || 'topsoil-estimate'}.${extension}`;
    link.click();
    URL.revokeObjectURL(link.href);
    closeExportModal();
    notify(`Exported ${payload.rows.length} row(s) as ${extension.toUpperCase()}.`);
  });
  const printEstimateBtn = document.querySelector('#print-estimate'); if (printEstimateBtn) printEstimateBtn.addEventListener('click', () => window.print());

  if (window.L) {
    state.map = L.map('map').setView([52.3887, -2.2491], 11);
    state.markers = L.layerGroup().addTo(state.map);
  } else {
    const mapStatus = document.querySelector('#map-status'); if (mapStatus) mapStatus.textContent = 'Map library did not load. Check your network, then refresh.';
  }
  const savedTheme = localStorage.getItem('topsoil-theme');
  applyTheme(savedTheme ? savedTheme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
  renderSavedEstimates();
  loadReviewQueue();
  loadSuppliers().catch(error => notify(error.message, true));
});
