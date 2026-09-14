// Scrapes the official FBM (Federación de Baloncesto de Madrid) league standings
// for every equipo + temporada ACTUAL ("is_current = true") that the app knows
// about, and writes them into the app's `standings_entries` Supabase table,
// replacing whatever was there before for each fase of each temporada.
//
// A season that has been closed ("Nueva Temporada" in the app, which sets
// is_current = false) is skipped ON PURPOSE from this point on: that is exactly
// what keeps its classification frozen forever, safe from a future fbm.es site
// change or URL move -- see the multi-team/multi-season migration
// (migracion_multiequipo_temporadas.sql) for the full explanation.
//
// Which page / fases to scrape for each team is read every run from the
// `seasons` table (columns fbm_url and the fbm_fases jsonb array -- each entry:
// { id, label, temporada, categoria, fase, grupo }), which you edit from the
// app itself, in "Mi Equipo" -> "Admin" -> "Fuente de Clasificación FBM" (it
// always edits the CURRENT season of whichever equipo you're viewing). That
// way, adding a new phase, rolling over to a new season, or the FBM site moving
// its page to a new URL is just editing those fields in the app -- no code
// changes and no touching this file.
//
// Each fase is scraped independently (its own Temporada/Categoría/Fase/Grupo
// selection) and written to standings_entries tagged with that fase's id AND
// its season's id, so rows from one fase/temporada never clobber another's --
// only that exact fase+temporada's own rows are replaced.
//
// Why Playwright and not a plain HTTP fetch: fbm.es's "Horarios y resultados" /
// "Temporadas anteriores" page is a classic ASP.NET WebForms app. Selecting each
// filter (Categoría, Grupo, ...) fires a real postback tied to server-side session
// state; a query-string "deep link" into informes.aspx was tested and found to
// NOT reliably reproduce a specific grupo's page cold -- it just redirects to
// whatever the current session's dropdowns are already set to. Driving the actual
// dropdowns with a real browser (same approach the site's own users take) is the
// robust way to get the right table every time.
//
// Run locally to test:
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/scrape-standings.mjs
// (SUPABASE_URL is not secret -- the app already ships it client-side -- but you
// can override it via env too if needed.)

import { chromium } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://amgmlsdbllknvwuixozc.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY env var (needed to bypass RLS and write standings_entries).');
  process.exit(1);
}

function normalize(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function supabaseRequest(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Supabase request failed: ' + res.status + ' ' + res.statusText + ' -- ' + body);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Construye la lista de "trabajos" a hacer: una entrada por cada fase de cada
// temporada ACTUAL de cada equipo. Las temporadas cerradas (is_current=false)
// ni siquiera se piden -- así quedan congeladas para siempre sin tener que
// acordarnos de excluirlas a mano en ningún sitio.
async function getScrapeJobs() {
  const [teams, seasons] = await Promise.all([
    supabaseRequest('/rest/v1/teams?select=id,name'),
    supabaseRequest('/rest/v1/seasons?select=id,team_id,label,fbm_url,fbm_fases&is_current=eq.true')
  ]);
  const teamsById = new Map((teams || []).map(t => [t.id, t]));
  const jobs = [];
  for (const season of seasons || []) {
    const team = teamsById.get(season.team_id);
    const teamName = team ? team.name : '(equipo desconocido)';
    if (!season.fbm_url) {
      console.warn('Temporada "' + season.label + '" de ' + teamName + ' no tiene "Página FBM" configurada todavía -- se salta.');
      continue;
    }
    const fases = Array.isArray(season.fbm_fases) ? season.fbm_fases : [];
    if (!fases.length) {
      console.warn('Temporada "' + season.label + '" de ' + teamName + ' no tiene ninguna fase configurada todavía -- se salta.');
      continue;
    }
    for (const f of fases) {
      // Fases marked "modo: manual" (clasificación hecha a mano, o bracket) don't
      // exist on fbm.es as a CLASIFICACIÓN table -- they're entered/edited from
      // within the app itself, so the robot must leave them alone entirely.
      if (f.modo === 'manual') continue;
      jobs.push({
        seasonId: season.id,
        seasonLabel: season.label,
        teamName,
        url: season.fbm_url,
        faseId: f.id,
        label: f.label || 'Fase',
        temporada: f.temporada || '',
        categoria: f.categoria || '',
        fase: f.fase || '',
        grupo: f.grupo || ''
      });
    }
  }
  return jobs;
}

// Selects an option by label, matched flexibly (case/accent-insensitive, via
// the same normalize() used for the own-team check) instead of Playwright's
// default exact-text match -- so a small case difference typed into the app's
// Admin screen (e.g. "Grupo 1" vs the site's real "GRUPO 1") doesn't silently
// retry-until-timeout with no useful error. Also triggers this site's real
// postback (a full page navigation, confirmed by hand -- this is a classic
// ASP.NET WebForms page, not an AJAX UpdatePanel) and waits for that
// navigation to actually finish, instead of a fixed sleep that can be too
// short under CI/runner network conditions and race the next dropdown's
// options not being in the DOM yet.
async function selectByFlexibleLabel(page, locator, wantedLabel, fieldName) {
  const options = await locator.locator('option').allTextContents();
  const wanted = normalize(wantedLabel);
  const match = options.find(o => normalize(o) === wanted);
  if (!match) {
    throw new Error(
      fieldName + ' "' + wantedLabel + '" does not match any option on the page. ' +
      'Available options: ' + options.filter(o => o.trim()).join(' | ')
    );
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
    locator.selectOption({ label: match })
  ]);
  // Small settle buffer for any late client-side rendering after the navigation
  // itself has already resolved -- not relied on for correctness, just courtesy.
  await page.waitForTimeout(400);
}

// Waits for a dropdown to actually be attached to the page (retrying, not a
// single instant check) before deciding it's genuinely absent -- a fixed sleep
// followed by one .count() check is a race: on a slower run the element can
// simply not have re-rendered yet from the previous postback.
async function waitForSelect(page, idSuffix, timeoutMs) {
  const locator = page.locator('select[id$="' + idSuffix + '"]');
  try {
    await locator.waitFor({ state: 'attached', timeout: timeoutMs || 8000 });
    return locator;
  } catch (e) {
    return null;
  }
}

async function scrapeStandings(browser, url, target) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // Temporada is optional: only touch it if configured, since changing it can
    // reset the Categoría list below it. Leave it alone otherwise (defaults to
    // whatever season the page loads with, normally the current one).
    if (target.temporada) {
      const temporadaSelect = await waitForSelect(page, 'DDLTemporadas');
      if (temporadaSelect) {
        await selectByFlexibleLabel(page, temporadaSelect, target.temporada, 'temporada');
      } else {
        console.warn('temporada is configured ("' + target.temporada + '") but no Temporada dropdown was found on the page -- continuing with the page\'s default season.');
      }
    }

    // Select Categoría -- triggers a postback that also refreshes Fase/Grupo.
    const categoriaSelect = await waitForSelect(page, 'DDLCategorias');
    if (!categoriaSelect) throw new Error('Categoría dropdown not found on the page -- the FBM site may have changed its markup.');
    await selectByFlexibleLabel(page, categoriaSelect, target.categoria, 'categoria');

    // Fase is optional: most categories only have one, which the page resolves on
    // its own. Only select it explicitly if configured (e.g. once a 2nd phase starts).
    if (target.fase) {
      const faseSelect = await waitForSelect(page, 'DDLFases');
      if (faseSelect) {
        await selectByFlexibleLabel(page, faseSelect, target.fase, 'fase');
      } else {
        console.warn('fase is configured ("' + target.fase + '") but no Fase dropdown was found on the page -- continuing.');
      }
    }

    // Select Grupo.
    const grupoSelect = await waitForSelect(page, 'DDLGrupos');
    if (!grupoSelect) throw new Error('Grupo dropdown not found on the page -- the FBM site may have changed its markup.');
    await selectByFlexibleLabel(page, grupoSelect, target.grupo, 'grupo');

    // Sanity check we actually landed on the right filters before trusting the table.
    const categoriaSelected = await categoriaSelect.locator('option:checked').innerText();
    const grupoSelected = await grupoSelect.locator('option:checked').innerText();
    if (!normalize(categoriaSelected).includes(normalize(target.categoria)) || !normalize(grupoSelected).includes(normalize(target.grupo))) {
      throw new Error('Filters did not land where expected (categoria="' + categoriaSelected + '", grupo="' + grupoSelected + '"). Check that the categoria/grupo for this fase match the exact label text on fbm.es, or that the FBM site hasn\'t changed its layout.');
    }

    const rows = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('h4, h3, h2'))
        .find(el => el.textContent.trim() === 'CLASIFICACIÓN');
      if (!heading) return null;
      let container = heading.parentElement;
      let table = null;
      for (let i = 0; i < 6 && container && !table; i++) {
        table = container.querySelector('table');
        container = container.parentElement;
      }
      if (!table) return null;
      return Array.from(table.querySelectorAll('tbody tr')).map(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        // Columns: N°, Nombre, P.J, P.G, P.P, P.E., P.F, P.C, Puntos
        return {
          position: parseInt(cells[0], 10),
          team_name: cells[1],
          pj: parseInt(cells[2], 10) || 0,
          pg: parseInt(cells[3], 10) || 0,
          pp: parseInt(cells[4], 10) || 0,
          pe: parseInt(cells[5], 10) || 0,
          pf: parseInt(cells[6], 10) || 0,
          pc: parseInt(cells[7], 10) || 0,
          pts: parseInt(cells[8], 10) || 0
        };
      });
    });

    if (!rows || !rows.length) {
      throw new Error('Found the filters but no CLASIFICACIÓN table/rows on the page. The FBM site may have changed its markup.');
    }
    return rows;
  } finally {
    await page.close();
  }
}

async function writeStandings(rows, ownTeamName, seasonId, faseId) {
  const ownNormalized = normalize(ownTeamName);
  const payload = rows.map(r => ({
    position: r.position,
    team_name: r.team_name,
    pj: r.pj,
    pg: r.pg,
    pp: r.pp,
    pe: r.pe || 0,
    pf: r.pf || 0,
    pc: r.pc || 0,
    pts: r.pts,
    is_own_team: normalize(r.team_name) === ownNormalized,
    season_id: seasonId,
    fase_id: faseId
  }));

  if (!payload.some(r => r.is_own_team)) {
    console.warn('Warning: none of the scraped teams matched the club\'s own team name ("' + ownTeamName + '"). Writing anyway, but double check the equipo\'s "Nombre" (Mi Equipo) matches the FBM team name.');
  }

  // Replace this fase+temporada's rows atomically-ish: delete only its previous
  // rows, then insert the fresh set -- every other fase/temporada is untouched.
  await supabaseRequest(
    '/rest/v1/standings_entries?season_id=eq.' + encodeURIComponent(seasonId) + '&fase_id=eq.' + encodeURIComponent(faseId),
    { method: 'DELETE' }
  );
  await supabaseRequest('/rest/v1/standings_entries', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(payload)
  });
}

(async () => {
  console.log('Leyendo equipos y temporadas actuales desde Supabase...');
  const jobs = await getScrapeJobs();
  if (!jobs.length) {
    console.log('No hay ninguna fase que actualizar ahora mismo (ningún equipo tiene una temporada actual con fases configuradas). Nada que hacer.');
    return;
  }
  console.log('Fases a actualizar: ' + jobs.length);

  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  let anyFailed = false;
  try {
    for (const target of jobs) {
      console.log('--- ' + target.teamName + ' / ' + target.seasonLabel + ' / ' + target.label + ' (fase=' + target.faseId + ') ---');
      console.log('Página: ' + target.url);
      console.log('Target -> temporada: ' + (target.temporada || '(por defecto de la página)') + ' | categoria: ' + target.categoria + ' | fase: ' + (target.fase || '(auto)') + ' | grupo: ' + target.grupo);
      try {
        console.log('Scraping standings from FBM...');
        const rows = await scrapeStandings(browser, target.url, target);
        console.log('Scraped ' + rows.length + ' teams:');
        rows.forEach(r => console.log('  ' + r.position + '. ' + r.team_name + ' -- ' + r.pj + 'PJ ' + r.pg + 'PG ' + r.pp + 'PP ' + r.pts + 'PTS'));

        console.log('Writing to Supabase (standings_entries, season_id=' + target.seasonId + ', fase_id=' + target.faseId + ')...');
        await writeStandings(rows, target.teamName, target.seasonId, target.faseId);
        console.log(target.teamName + ' / ' + target.label + ': done.');
      } catch (err) {
        anyFailed = true;
        console.error(target.teamName + ' / ' + target.label + ' failed: ' + err.message);
      }
    }
  } finally {
    await browser.close();
  }

  if (anyFailed) {
    console.error('One or more fases failed to update (see above). Fases that succeeded were still written.');
    process.exit(1);
  }
  console.log('Done.');
})().catch(err => {
  console.error('Scrape failed:', err.message);
  process.exit(1);
});
