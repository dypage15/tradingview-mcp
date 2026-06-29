/**
 * Core indicator settings logic.
 */
import { evaluate } from '../connection.js';
import { strategyTesterClickUpdateReportIfPresent } from './ui.js';
import { buildResolveBenchStudyHandlesBlock } from './studyBenchResolve.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function setInputs({ entity_id, inputs: inputsRaw, persist_layout = true }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const escapedId = entity_id.replace(/'/g, "\\'");
  const inputsJson = JSON.stringify(inputs);
  const persistFlag = persist_layout !== false;

  const resolveBlock = buildResolveBenchStudyHandlesBlock(escapedId);
  const result = await evaluate(`
    (function() {
      ${resolveBlock}
      var chart = ${CHART_API};
      var study = __resolveBenchStudyForInputs(chart);
      if (!study) return { error: 'Study not found: ${escapedId}' };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          var cur = currentInputs[i];
          var v = overrides[cur.id];
          if (typeof cur.value === 'boolean' && typeof v !== 'boolean') v = Boolean(v);
          else if (typeof cur.value === 'number' && typeof v === 'string') v = parseFloat(v);
          else if (typeof cur.value === 'string' && typeof v !== 'string') v = String(v);
          cur.value = v;
          updatedKeys[cur.id] = v;
        }
      }
      study.setInputValues(currentInputs);
      var layoutSaved = false;
      if (${persistFlag ? 'true' : 'false'}) {
        try {
          var cw = chart._chartWidget;
          if (cw && cw._saveChartService && typeof cw._saveChartService._doSave === 'function') {
            cw._saveChartService._doSave();
            layoutSaved = true;
          }
        } catch (e0) {}
      }
      return { updated_inputs: updatedKeys, layout_save_called: layoutSaved };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  await new Promise((r) => setTimeout(r, 280));
  const updateReportAck = await strategyTesterClickUpdateReportIfPresent({ max_attempts: 4, pause_ms: 450 });
  return {
    success: true,
    entity_id,
    updated_inputs: result.updated_inputs,
    layout_save_called: result.layout_save_called === true,
    update_report_banner_clicks: updateReportAck.clicks,
    update_report_banner_text: updateReportAck.last_clicked_text ?? null,
  };
}

export async function toggleVisibility({ entity_id, visible }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const escapedId = entity_id.replace(/'/g, "\\'");
  const resolveBlockVis = buildResolveBenchStudyHandlesBlock(escapedId);
  const result = await evaluate(`
    (function() {
      ${resolveBlockVis}
      var chart = ${CHART_API};
      var study = __resolveStudyForVisibility(chart);
      if (!study || typeof study.setVisible !== 'function') return { error: 'Study not found: ${escapedId}' };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}
