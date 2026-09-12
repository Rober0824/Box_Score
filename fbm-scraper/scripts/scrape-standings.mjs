// Scrapes the official FBM (Federación de Baloncesto de Madrid) league standings
// for a specific grupo and writes them into the app's `standings_entries` Supabase
// table, replacing whatever was there before.
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

// --- FBM filter selections for this team's league. Update these if the category,
// phase or group changes in a future season (e.g. she moves up an age group). ---
const FBM_URL = 'https://www.fbm.es/es/temporadas-anteriores';
const CATEGORIA_LABEL = 'Alv Fem 1ºaño LIGA MARCO ALDANY';
const GRUPO_LABEL = 'GRUPO 2';
// Fallback own-team name match if club_settings can't be read for any reason.
const FALLBACK_OWN_TEAM = 'DISTRITO OLIMPICO ARRANZ';

function normalize(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
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

async function getOwnTeamName() {
  try {
    const rows = await supabaseRequest('/rest/v1/club_settings?select=team_name&limit=1');
    if (rows && rows[0] && rows[0].team_name) return rows[0].team_name;
  } catch (e) {
    console.warn('Could not read club_settings.team_name, falling back to hardcoded name:', e.message);
  }
  return FALLBACK_OWN_TEAM;
}

async function scrapeStandings() {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  try {
    await page.goto(FBM_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // Select Categoría -- triggers a postback that also refreshes Fase/Grupo.
    const categoriaSelect = page.locator('select[id$="DDLCategorias"]');
    await categoriaSelect.selectOption({ label: CATEGORIA_LABEL });
    await page.waitForTimeout(1800);

    // Select Grupo (Fase resolves itself automatically when there's only one option).
    const grupoSelect = page.locator('select[id$="DDLGrupos"]');
    await grupoSelect.selectOption({ label: GRUPO_LABEL });
    await page.waitForTimeout(1800);

    // Sanity check we actually landed on the right filters before trusting the table.
    const categoriaSelected = await categoriaSelect.locator('option:checked').innerText();
    const grupoSelected = await grupoSelect.locator('option:checked').innerText();
    if (!categoriaSelected.includes('Alv Fem 1') || !grupoSelected.includes('GRUPO 2')) {
      throw new Error('Filters did not land where expected (categoria="' + categoriaSelected + '", grupo="' + grupoSelected + '"). The FBM site may have changed its layout -- check scripts/scrape-standings.mjs.');
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
  console.log('Fetching own team name from club_settings...');
  const ownTeamName = await getOwnTeamName();
  console.log('Own team:', ownTeamName);

  console.log('Scraping standings from FBM (' + CATEGORIA_LABEL + ' / ' + GRUPO_LABEL + ')...');
  const rows = await scrapeStandings();
  console.log('Scraped ' + rows.length + ' teams:');
  rows.forEach(r => console.log('  ' + r.position + '. ' + r.team_name + ' -- ' + r.pj + 'PJ ' + r.pg + 'PG ' + r.pp + 'PP ' + r.pts + 'PTS'));

  console.log('Writing to Supabase (standings_entries)...');
  await writeStandings(rows, ownTeamName);
  console.log('Done.');
})().catch(err => {
  console.error('Scrape failed:', err.message);
  process.exit(1);
});
