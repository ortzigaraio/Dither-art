// Every user-visible string goes through t() (PLAN.md 1.5, 11): the dictionaries must stay in sync with the code.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gotoApp, loadFixture, watchPage, setControl } from './helpers.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

// src/ has no package.json "type": "module", so Node would read these files as CommonJS: load them as data modules.
const dict = async (lang) => {
  const src = readFileSync(join(root, 'src/i18n', `${lang}.js`), 'utf8');
  return (await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`)).default;
};

test.describe('i18n', () => {
  test('ES and EN have exactly the same keys and no empty values', async () => {
    const es = await dict('es');
    const en = await dict('en');
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of [...Object.entries(es), ...Object.entries(en)]) {
      expect(typeof v, k).toBe('string');
      expect(v.trim().length, k).toBeGreaterThan(0);
    }
    // placeholders must match between languages
    for (const k of Object.keys(en)) {
      const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
      expect(vars(es[k]), `placeholders of ${k}`).toBe(vars(en[k]));
    }
  });

  test('every key used in the code or in index.html exists', async () => {
    const en = await dict('en');
    const files = walk(join(root, 'src')).filter((f) => f.endsWith('.js') && !f.includes('/i18n/'));
    const used = new Set();
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*(['"])([a-zA-Z0-9_.]+)\1/g)) used.add(m[2]);
      for (const m of src.matchAll(/labelKey:\s*(['"])([a-zA-Z0-9_.]+)\1/g)) used.add(m[2]);
    }
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
    for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(';')) used.add(pair.slice(pair.indexOf(':') + 1).trim());
    }
    // keys built from a template literal: t(`theme.${id}`) ...
    for (const id of ['horain', 'claro', 'amber', 'crt', 'paper', 'cad']) used.add(`theme.${id}`);
    for (const c of ['text', 'pixel', 'vector', '3d', 'sim']) used.add(`cat.${c}`);
    for (const tab of ['image', 'mode', 'color', 'export']) used.add(`studio.tab.${tab}`);
    for (const f of ['txt', 'html', 'ansi']) used.add(`export.${f}`);
    for (const c of ['unsupported', 'empty', 'tooLarge', 'tooManyPixels', 'decode']) used.add(`err.${c}`);
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(60);
  });

  test('every param of every schema has ES and EN labels, help and options', async ({ page }) => {
    await gotoApp(page);
    const problems = await page.evaluate(async () => {
      const { MODES } = await import('/src/modes/index.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const bad = [];
      const check = (where, v) => {
        if (typeof v === 'string') { if (!v.trim()) bad.push(`${where}: empty`); return; }
        if (!v || !v.es || !v.en || !String(v.es).trim() || !String(v.en).trim()) bad.push(`${where}: missing es/en`);
      };
      const walk = (where, schema) => {
        for (const p of schema) {
          check(`${where}.${p.id}.label`, p.label);
          if (p.help) check(`${where}.${p.id}.help`, p.help);
          for (const o of p.options || []) check(`${where}.${p.id}.option.${o.value}`, o.label);
        }
      };
      walk('global', IMAGE_PARAMS);
      walk('color', COLOR_PARAMS);
      for (const m of MODES) {
        check(`${m.id}.name`, m.name);
        check(`${m.id}.blurb`, m.blurb);
        walk(m.id, m.params);
      }
      return bad;
    });
    expect(problems).toEqual([]);
  });

  test('the Spanish UI shows no English leftovers in the studio', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => localStorage.setItem('horain.lang', 'es'));
    await gotoApp(page);
    await loadFixture(page);
    await setControl(page, 'edges', 4);
    await setControl(page, 'gradient', 'custom');
    const texts = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('#studio .label, #studio .ctl-label, #studio .btn, #studio .group-title, #studio .mode-item-name, #studio .sheet-tab, #studio option')) {
        if (el.closest('[hidden]')) continue;
        out.push(el.textContent.trim());
      }
      return out;
    });
    const english = ['Brightness', 'Contrast', 'Saturation', 'Grayscale', 'Thresholding', 'Sharpness', 'Edge Detection', 'Quality Enhancements', 'Space Density', 'Download PNG', 'Settings', 'Output'];
    for (const w of english) expect(texts, w).not.toContain(w);
    for (const w of ['Brillo', 'Contraste', 'Saturación', 'Escala de grises', 'Sepia', 'Umbral', 'Nitidez', 'Detección de bordes', 'Mejoras de calidad', 'Densidad de espacio', 'Descargar PNG']) {
      expect(texts, w).toContain(w);
    }
    await guard.assertClean(expect);
  });

  test('documented labels from the reference panel exist in both languages', async ({ page }) => {
    await gotoApp(page);
    await loadFixture(page);
    const labels = async () => page.evaluate(() => Array.from(document.querySelectorAll('#controls .ctl-label')).map((e) => e.textContent.trim()));
    const en = await labels();
    for (const l of ['Characters / Resolution', 'Brightness', 'Contrast', 'Saturation', 'Hue', 'Grayscale', 'Sepia', 'Invert Colors', 'Thresholding', 'Sharpness', 'Edge Detection', 'Quality Enhancements', 'Transparent frame', 'ASCII gradient', 'Space Density']) {
      expect(en, l).toContain(l);
    }
    await page.click('.lang-toggle [data-lang="es"]');
    const es = await labels();
    for (const l of ['Caracteres / Resolución', 'Brillo', 'Contraste', 'Saturación', 'Tono', 'Escala de grises', 'Invertir colores', 'Umbral', 'Nitidez', 'Detección de bordes', 'Mejoras de calidad', 'Marco transparente', 'Gradiente de caracteres', 'Densidad de espacio']) {
      expect(es, l).toContain(l);
    }
  });
});
