// Scrapes the official FBM (Federación de Baloncesto de Madrid) league standings
// for a specific grupo and writes them into the app's `standings_entries` Supabase
// table, replacing whatever was there before.
//
// Which Temporada / Categoría / Fase / Grupo to scrape is NOT hardcoded here anymore:
// it's read every run from the `club_settings` table (columns fbm_temporada,
// fbm_categoria, fbm_fase, fbm_grupo), which you edit from the app itself, in
// "Mi Equipo" -> "Fuente de clasificación (FBM)". That way, changing phase or
// rolling over to a new season is just editing those fields in the app -- no code
// changes and no touching this file.
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

const FBM_URL = 'https://www.fbm.es/es/temporadas-anteriores';

// Used only if club_settings has no fbm_categoria / fbm_grupo / team_name configured
// yet (e.g. right after installing this for the very first time). Fill in the real
// values from the app as soon as you can -- these fallbacks are just a safety net.
const FALLBACK_CATEGORIA = 'Alv Fem 1ºaño LIGA MARCO ALDANY';
const FALLBACK_GRUPO = 'GRUPO 2';
const FALLBACK_OWN_TEAM = 'DISTRITO OLIMPICO ARRANZ';

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

// Reads the club's own team name and the FBM target (temporada/categoria/fase/grupo)
// from club_settings, falling back to hardcoded defaults for anything not set.
async function getFbmTarget() {
  const target = {
    teamName: FALLBACK_OWN_TEAM,
    temporada: '',
    categoria: FALLBACK_CATEGORIA,
    fase: '',
    grupo: FALLBACK_GRUPO,
    usedFallbackCategoria: true,
    usedFallbackGrupo: true
  };
  try {
    const rows = await supabaseRequest('/rest/v1/club_settings?select=team_name,fbm_temporada,fbm_categoria,fbm_fase,fbm_grupo&limit=1');
    const row = rows && rows[0];
    if (row) {
      if (row.team_name) target.teamName = row.team_name;
      if (row.fbm_temporada) target.temporada = row.fbm_temporada;
      if (row.fbm_categoria) { target.categoria = row.fbm_categoria; target.usedFallbackCategoria = false; }
      if (row.fbm_fase) target.fase = row.fbm_fase;
      if (row.fbm_grupo) { target.grupo = row.fbm_grupo; target.usedFallbackGrupo = false; }
    }
  } catch (e) {
    console.warn('Could not read club_settings, falling back to hardcoded defaults:', e.message);
  }
  return target;
}

async function scrapeStandings(target) {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  try {
    await page.goto(FBM_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // Temporada is optional: only touch it if configured, since changing it can
    // reset the Categoría list below it. Leave it alone otherwise (defaults to
    // whatever season the page loads with, normally the current one).
    if (target.temporada) {
      const temporadaSelect = page.locator('select[id$="DDLTemporadas"]');
      if (await temporadaSelect.count()) {
        await temporadaSelect.selectOption({ label: target.temporada });
        await page.waitForTimeout(1800);
      } else {
        console.warn('fbm_temporada is configured ("' + target.temporada + '") but no Temporada dropdown was found on the page -- continuing with the page\'s default season.');
      }
    }

    // Select Categoría -- triggers a postback that also refreshes Fase/Grupo.
    const categoriaSelect = page.locator('select[id$="DDLCategorias"]');
    await categoriaSelect.selectOption({ label: target.categoria });
    await page.waitForTimeout(1800);

    // Fase is optional: most categories only have one, which the page resolves on
    // its own. Only select it explicitly if configured (e.g. once a 2nd phase starts).
    if (target.fase) {
      const faseSelect = page.locator('select[id$="DDLFases"]');
      if (await faseSelect.count()) {
        await faseSelect.selectOption({ label: target.fase });
        await page.waitForTimeout(1800);
      } else {
        console.warn('fbm_fase is configured ("' + target.fase + '") but no Fase dropdown was found on the page -- continuing.');
      }
    }

    // Select Grupo.
    const grupoSelect = page.locator('select[id$="DDLGrupos"]');
    await grupoSelect.selectOption({ label: target.grupo });
    await page.waitForTimeout(1800);

    // Sanity check we actually landed on the right filters before trusting the table.
    const categoriaSelected = await categoriaSelect.locator('option:checked').innerText();
    const grupoSelected = await grupoSelect.locator('option:checked').innerText();
    if (!normalize(categoriaSelected).includes(normalize(target.categoria)) || !normalize(grupoSelected).includes(normalize(target.grupo))) {
      throw new Error('Filters did not land where expected (categoria="' + categoriaSelected + '", grupo="' + grupoSelected + '"). Check that fbm_categoria/fbm_grupo in club_settings match the exact label text on fbm.es, or that the FBM site hasn\'t changed its layout.');
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
          pts: parseInt(cells[8], 10) || 0
        };
      });
    });

    if (!rows || !rows.length) {
      throw new Error('Found the filters but no CLASIFICACIÓN table/rows on the page. The FBM site may have changed its markup.');
    }
    return rows;
  } finally {
    await browser.close();
  }
}

async function writeStandings(rows, ownTeamName) {
  const ownNormalized = normalize(ownTeamName);
  const payload = rows.map(r => ({
    position: r.position,
    team_name: r.team_name,
    pj: r.pj,
    pg: r.pg,
    pp: r.pp,
    pts: r.pts,
    is_own_team: normalize(r.team_name) === ownNormalized
  }));

  if (!payload.some(r => r.is_own_team)) {
    console.warn('Warning: none of the scraped teams matched the club\'s own team name ("' + ownTeamName + '"). Writing anyway, but double check club_settings.team_name matches the FBM team name.');
  }

  // Replace the whole table atomically-ish: delete everything, then insert the fresh set.
  await supabaseRequest('/rest/v1/standings_entries?id=not.is.null', { method: 'DELETE' });
  await supabaseRequest('/rest/v1/standings_entries', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(payload)
  });
}

(async () => {
  console.log('Reading FBM target (temporada/categoria/fase/grupo) from club_settings...');
  const target = await getFbmTarget();
  if (target.usedFallbackCategoria || target.usedFallbackGrupo) {
    console.warn('fbm_categoria/fbm_grupo are not fully configured in club_settings yet -- using the built-in fallback values. Fill them in from the app (Mi Equipo) so this stays correct season to season.');
  }
  console.log('Own team:', target.teamName);
  console.log('Target -> temporada: ' + (target.temporada || '(por defecto de la página)') + ' | categoria: ' + target.categoria + ' | fase: ' + (target.fase || '(auto)') + ' | grupo: ' + target.grupo);

  console.log('Scraping standings from FBM...');
  const rows = await scrapeStandings(target);
  console.log('Scraped ' + rows.length + ' teams:');
  rows.forEach(r => console.log('  ' + r.position + '. ' + r.team_name + ' -- ' + r.pj + 'PJ ' + r.pg + 'PG ' + r.pp + 'PP ' + r.pts + 'PTS'));

  console.log('Writing to Supabase (standings_entries)...');
  await writeStandings(rows, target.teamName);
  console.log('Done.');
})().catch(err => {
  console.error('Scrape failed:', err.message);
  process.exit(1);
});
