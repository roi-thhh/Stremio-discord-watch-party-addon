import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const ADDONS_FILE = path.join(DATA_DIR, 'addons.json');

const DEFAULT_ADDONS = [
  {
    id: 'com.linvo.cinemeta',
    name: 'Cinemeta',
    version: '3.0.13',
    description: 'The official addon for movie and series catalogs',
    manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    catalogs: [
      { type: 'movie', id: 'top', name: 'Popular' },
      { type: 'series', id: 'top', name: 'Popular' },
      { type: 'movie', id: 'year', name: 'New' },
      { type: 'series', id: 'year', name: 'New' }
    ]
  }
];

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(ADDONS_FILE);
  } catch {
    await fs.writeFile(ADDONS_FILE, JSON.stringify(DEFAULT_ADDONS, null, 2), 'utf8');
  }
}

export async function getAddons() {
  await ensureDataFile();
  const raw = await fs.readFile(ADDONS_FILE, 'utf8');
  return JSON.parse(raw);
}

async function saveAddons(addons) {
  await ensureDataFile();
  await fs.writeFile(ADDONS_FILE, JSON.stringify(addons, null, 2), 'utf8');
}

export function normalizeManifestUrl(inputUrl) {
  let url = inputUrl.trim();
  if (url.startsWith('stremio://')) {
    url = 'https://' + url.slice('stremio://'.length);
  }
  if (!url.endsWith('/manifest.json') && !url.includes('/manifest.json?')) {
    url = url.replace(/\/+$/, '') + '/manifest.json';
  }
  return url;
}

export async function installAddon(inputUrl) {
  const manifestUrl = normalizeManifestUrl(inputUrl);
  const res = await fetch(manifestUrl, {
    headers: { 'User-Agent': 'StremioDiscordActivity/1.0' }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch manifest (${res.status} ${res.statusText})`);
  }
  const manifest = await res.json();
  if (!manifest?.id || !manifest?.name) {
    throw new Error('Invalid Stremio addon manifest: missing id or name');
  }

  const addonRecord = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version || '1.0.0',
    description: manifest.description || '',
    logo: manifest.logo || '',
    manifestUrl,
    resources: (manifest.resources || []).map((r) => (typeof r === 'string' ? r : r.name)),
    rawResources: manifest.resources || [],
    types: manifest.types || [],
    catalogs: manifest.catalogs || [],
    idPrefixes: manifest.idPrefixes || null
  };

  const addons = await getAddons();
  const idx = addons.findIndex((a) => a.manifestUrl === manifestUrl || a.id === addonRecord.id);
  if (idx >= 0) {
    addons[idx] = addonRecord;
  } else {
    addons.push(addonRecord);
  }
  await saveAddons(addons);
  return addonRecord;
}

export async function removeAddon(id) {
  const addons = await getAddons();
  const filtered = addons.filter((a) => a.id !== id);
  await saveAddons(filtered);
  return filtered;
}

function getBaseUrl(manifestUrl) {
  return manifestUrl.replace(/\/manifest\.json(\?.*)?$/, '');
}

function formatExtra(extra) {
  if (!extra) return '';
  return extra
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return encodeURIComponent(pair);
      const k = pair.slice(0, eq);
      const v = pair.slice(eq + 1);
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
}

export async function fetchCatalog({ addonId, type, id, extra = '' }) {
  const addons = await getAddons();
  const addon = addonId
    ? addons.find((a) => a.id === addonId)
    : addons.find((a) => a.resources.includes('catalog'));

  if (!addon) throw new Error('Catalog addon not found');

  const base = getBaseUrl(addon.manifestUrl);
  const formattedExtra = formatExtra(extra);
  const extraPart = formattedExtra ? `/${formattedExtra}` : '';
  const url = `${base}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPart}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Catalog fetch failed (${res.status})`);
  return res.json();
}

export async function searchCatalogs({ query }) {
  const addons = await getAddons();
  const targets = [];

  for (const addon of addons) {
    if (!addon.resources.includes('catalog')) continue;
    const catalogs = addon.catalogs || [];
    for (const cat of catalogs) {
      const extraSupported = (cat.extra || []).some((e) => e.name === 'search');
      const isDefaultSearchable = cat.id === 'top' || cat.id === 'search';
      if (extraSupported || isDefaultSearchable) {
        targets.push({ addon, cat });
      }
    }
  }

  // Deduplicate by addonId + type + id
  const seenTargets = new Set();
  const uniqueTargets = targets.filter(({ addon, cat }) => {
    const key = `${addon.id}:${cat.type}:${cat.id}`;
    if (seenTargets.has(key)) return false;
    seenTargets.add(key);
    return true;
  });

  const results = await Promise.allSettled(
    uniqueTargets.map(async ({ addon, cat }) => {
      const base = getBaseUrl(addon.manifestUrl);
      const url = `${base}/catalog/${encodeURIComponent(cat.type)}/${encodeURIComponent(cat.id)}/search=${encodeURIComponent(query)}.json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const data = await res.json();
      return data.metas || [];
    })
  );

  const metas = [];
  const seenIds = new Set();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const m of r.value) {
        const key = `${m.type}:${m.id}`;
        if (!seenIds.has(key)) {
          seenIds.add(key);
          metas.push(m);
        }
      }
    }
  }
  return { metas };
}

export async function fetchMeta({ type, id }) {
  const addons = await getAddons();
  const metaAddons = addons.filter((a) => a.resources.includes('meta'));
  for (const addon of metaAddons) {
    if (addon.idPrefixes && !addon.idPrefixes.some((p) => id.startsWith(p))) {
      continue;
    }
    const base = getBaseUrl(addon.manifestUrl);
    const url = `${base}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data?.meta) return data;
      }
    } catch {
      // Try next meta addon
    }
  }
  throw new Error('Metadata not found in any installed addon');
}

export async function fetchStreams({ type, id }) {
  const addons = await getAddons();
  const streamAddons = addons.filter((a) => a.resources.includes('stream'));

  const results = await Promise.allSettled(
    streamAddons.map(async (addon) => {
      if (addon.idPrefixes && !addon.idPrefixes.some((p) => id.startsWith(p))) {
        return [];
      }
      const base = getBaseUrl(addon.manifestUrl);
      const url = `${base}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.streams || []).map((s, index) => ({
        ...s,
        _addonId: addon.id,
        _addonName: addon.name,
        _index: index
      }));
    })
  );

  const streams = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      streams.push(...r.value);
    }
  }
  return { streams };
}
