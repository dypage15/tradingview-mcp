import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor', {
    source: z.string().describe('Pine Script source code to inject'),
  }, async ({ source }) => {
    try { return jsonResult(await core.setSource({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {}, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save', 'Save the current Pine Script (Ctrl+S)', {}, async () => {
    try { return jsonResult(await core.save()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes. Optionally on stale "cannot parse" markers removes a chart study then re-adds from the editor (recover_parse).', {
    recover_parse: z.boolean().optional().describe('If true with recover_study_contains or recover_entity_id, remove matching study then compile again when Monaco shows parse-shaped errors.'),
    recover_entity_id: z.string().optional().describe('Entity id from chart_get_state — study to remove during parse recovery.'),
    recover_study_contains: z.string().optional().describe('Substring to match chart study name for removal during parse recovery (e.g. "ERL IRL").'),
  }, async ({ recover_parse, recover_entity_id, recover_study_contains }) => {
    try {
      const selectors =
        !!(recover_entity_id || '').trim() ||
        !!(recover_study_contains || '').trim();
      let rp = recover_parse;
      if (rp === undefined && selectors) rp = true;

      const args = {};
      if (rp !== undefined) args.recover_parse = rp;
      const eid = String(recover_entity_id || '').trim();
      const sub = String(recover_study_contains || '').trim();
      if (eid) args.recover_entity_id = eid;
      if (sub) args.recover_study_contains = sub;
      const hasOpts = Object.keys(args).length > 0;
      return jsonResult(await core.smartCompile(hasOpts ? args : {}));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_new', 'Create a new blank Pine Script', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  }, async ({ type }) => {
    try { return jsonResult(await core.newScript({ type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open', 'Open a saved Pine Script by name or script_id', {
    name: z.string().optional().describe('Name of the saved script to open (case-insensitive match)'),
    script_id: z.string().optional().describe('Exact script id (e.g. USER;954e7ef8...) — preferred when duplicates exist'),
  }, async ({ name, script_id }) => {
    try { return jsonResult(await core.openScript({ name, script_id })); }
    catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
