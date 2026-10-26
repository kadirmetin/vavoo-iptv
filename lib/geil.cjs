"use strict";

const ORIGIN = "https://geil.to";
const CATALOG_URL = `${ORIGIN}/live/catalog/live/channels.json`;

function failure(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function channelId(value) {
  const id = String(value ?? "");
  if (!/^\d{1,20}$/.test(id)) throw failure("Geçersiz Geil kanal kimliği", 400);
  return id;
}

async function requestJson(url) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(20000)
      });
      if (response.status < 500 || attempt === 2) break;
      await response.body?.cancel();
    } catch {
      if (attempt === 2) throw failure("Geil bağlantısı kurulamadı");
    }
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (!response.ok) throw failure(`Geil HTTP ${response.status}`, response.status);
  return response.json();
}

function epochSeconds(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return NaN;
  const timestamp = Date.parse(value);
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  // Date.parse coerces numeric inputs and rolls impossible calendar dates forward.
  if (!Number.isFinite(timestamp) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  return timestamp / 1000;
}

function normalizeChannel(item) {
  if (!item || typeof item.name !== "string" || !item.name.trim()) {
    throw failure("Geil kanal verisi geçersiz");
  }
  const id = channelId(item.id);
  const epg = [];
  for (const programme of Array.isArray(item.epg) ? item.epg : []) {
    if (!programme || typeof programme.title !== "string" || !programme.title.trim()) continue;
    const start = epochSeconds(programme.start);
    const stop = epochSeconds(programme.end);
    if (Number.isFinite(start) && Number.isFinite(stop) && stop > start) {
      epg.push({ name: programme.title, start, stop });
    }
  }
  return {
    name: item.name,
    url: `${ORIGIN}/live/play/${id}`,
    ids: { ...item.ids, id },
    logo: typeof item.logo === "string" ? item.logo : "",
    epg
  };
}

async function fetchChannels() {
  const channels = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 200; page++) {
    const url = new URL(CATALOG_URL);
    url.searchParams.set("filter[group]", "Turkey");
    url.searchParams.set("sort", "name");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const data = await requestJson(url);
    if (!data || !Array.isArray(data.items)) throw failure("Geil katalog yanıtı geçersiz");
    channels.push(...data.items.map(normalizeChannel));
    const next = data.nextCursor;
    if (next === null || next === undefined || next === "") {
      if (!channels.length) throw failure("Geil kataloğu boş");
      return channels;
    }
    if (typeof next !== "string" || cursors.has(next)) throw failure("Geil cursor döngüsü veya geçersiz cursor");
    cursors.add(next);
    cursor = next;
  }
  throw failure("Geil katalog sayfa sınırı aşıldı");
}

async function resolveChannel(value) {
  const id = channelId(value);
  const url = new URL(`${ORIGIN}/live/resolve`);
  url.searchParams.set("url", `${ORIGIN}/live/play/${id}`);
  const data = await requestJson(url);
  let stream;
  try { stream = new URL(data?.url); } catch { throw failure("Geil yayın adresi geçersiz"); }
  if (!["http:", "https:"].includes(stream.protocol) || stream.username || stream.password) {
    throw failure("Geil yayın adresi geçersiz");
  }
  return stream.toString();
}

module.exports = { ORIGIN, CATALOG_URL, fetchChannels, resolveChannel };
