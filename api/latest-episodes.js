import crypto from "node:crypto";

import {
  checkAuth,
  fetchCachedJson,
  getDataRawUrl,
  sendJsonText
} from "./shared.js";

const ORDER_STATE_KEY = "bidamax:latest-episodes:order:v2";
const ORDER_STATE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const aggregateCache = globalThis.__BIDAMAX_LATEST_EPISODES_CACHE__ || {
  body: "",
  expiresAt: 0,
  staleUntil: 0,
  generatedAt: 0
};

const memoryOrderState = globalThis.__BIDAMAX_LATEST_EPISODES_ORDER__ || {
  version: 2,
  items: {}
};

globalThis.__BIDAMAX_LATEST_EPISODES_CACHE__ = aggregateCache;
globalThis.__BIDAMAX_LATEST_EPISODES_ORDER__ = memoryOrderState;

function text(value) {
  return value === null || value === undefined
    ? ""
    : String(value).trim();
}

function number(value) {
  const parsed = Number(text(value).replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function valid(value) {
  const clean = text(value);
  return clean !== "" &&
    clean.toLowerCase() !== "null" &&
    clean.toLowerCase() !== "n/a";
}

function positiveSeconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isOngoing(series) {
  let rawStatus = series.SeriesStatus;

  if (!valid(rawStatus)) rawStatus = series.status;
  if (!valid(rawStatus)) rawStatus = series.Status;

  const status = text(rawStatus)
    .toLowerCase()
    .replace(/[_-]+/g, " ");

  return status === "returning series" ||
    status === "ongoing" ||
    status === "in production" ||
    status === "planned";
}

function episodeSeason(episode) {
  return number(
    episode.season ||
    episode.season_number ||
    episode.Season ||
    episode.SeasonNumber
  );
}

function episodeNumber(episode) {
  return number(
    episode.episode ||
    episode.episode_number ||
    episode.Episode ||
    episode.EpisodeNumber
  );
}

function episodeLink(episode) {
  return text(
    episode.link ||
    episode.Link ||
    episode.video_url ||
    episode.VideoUrl ||
    episode.VideoURL ||
    episode.url
  );
}

function isPlayable(episode) {
  return valid(episodeLink(episode));
}

function expectedEpisodeCount(series) {
  const values = [
    series.NumberOfEpisodes,
    series.number_of_episodes,
    series.EpisodeCount,
    series.episode_count,
    series.Episodes
  ];

  for (const value of values) {
    const count = number(value);
    if (count > 0) return count;
  }

  return 0;
}

function seriesId(series) {
  return text(series.tmdbID || series.tmdbId || series.id);
}

function episodeStill(episode) {
  if (!episode) return "";

  return text(
    episode.still_path ||
    episode.Still ||
    episode.poster ||
    episode.Poster
  );
}

function episodeAirDate(episode) {
  if (!episode) return "";

  return text(
    episode.air_date ||
    episode.AirDate ||
    episode.date_added ||
    episode.DateAdded
  );
}

function episodeSignature(episodes) {
  const rows = episodes
    .filter(Boolean)
    .map((episode) => ({
      season: episodeSeason(episode),
      episode: episodeNumber(episode),
      id: text(episode.id || episode.ID),
      link: episodeLink(episode)
    }))
    .filter((episode) => episode.season > 0 && episode.episode > 0)
    .sort((first, second) => {
      const seasonOrder = first.season - second.season;
      if (seasonOrder !== 0) return seasonOrder;

      const episodeOrder = first.episode - second.episode;
      if (episodeOrder !== 0) return episodeOrder;

      return first.id.localeCompare(second.id);
    });

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
}

function groupBySeason(episodes) {
  const seasons = new Map();

  for (const episode of episodes) {
    if (!episode) continue;

    const season = episodeSeason(episode);
    const episodeNo = episodeNumber(episode);

    if (season <= 0 || episodeNo <= 0) continue;

    if (!seasons.has(season)) {
      seasons.set(season, new Map());
    }

    const entries = seasons.get(season);
    const current = entries.get(episodeNo);

    // Prefer a playable duplicate so one blank duplicate cannot hide its link.
    if (!current || (!isPlayable(current) && isPlayable(episode))) {
      entries.set(episodeNo, episode);
    }
  }

  return seasons;
}

function seasonProgress(season, entries) {
  const episodeNumbers = Array.from(entries.keys()).sort((a, b) => a - b);
  const total = episodeNumbers.length === 0
    ? 0
    : episodeNumbers[episodeNumbers.length - 1];

  let completedThrough = 0;
  let playableCount = 0;
  let latestPlayable = null;

  for (const episodeNo of episodeNumbers) {
    const episode = entries.get(episodeNo);

    if (isPlayable(episode)) {
      playableCount += 1;

      if (!latestPlayable || episodeNo > episodeNumber(latestPlayable)) {
        latestPlayable = episode;
      }
    }
  }

  for (let episodeNo = 1; episodeNo <= total; episodeNo += 1) {
    const episode = entries.get(episodeNo);

    if (!episode || !isPlayable(episode)) break;
    completedThrough = episodeNo;
  }

  const lastEntry = total > 0 ? entries.get(total) : null;

  return {
    season,
    total,
    completedThrough,
    playableCount,
    isIncomplete: total > 0 && completedThrough < total,
    displayEpisode: completedThrough > 0
      ? entries.get(completedThrough)
      : (latestPlayable || lastEntry),
    latestPlayable
  };
}

export function makeProgressBadge(season, episode, total) {
  return `Ongoing • S${season} EP${episode}/${total}`;
}

export function analyzeEpisodes(series, episodes) {
  if (!Array.isArray(episodes)) return null;

  const id = seriesId(series);
  if (!valid(id)) return null;

  const seasons = groupBySeason(episodes);
  const progress = Array.from(seasons.entries())
    .map(([season, entries]) => seasonProgress(season, entries))
    .sort((first, second) => second.season - first.season);

  const playable = episodes.filter((episode) => episode && isPlayable(episode));
  const ongoingSeason = progress.find(
    (item) => item.isIncomplete && item.completedThrough > 0
  );
  const signature = episodeSignature(episodes);

  let latestPlayableOverall = null;

  for (const episode of playable) {
    if (!latestPlayableOverall) {
      latestPlayableOverall = episode;
      continue;
    }

    const seasonOrder = episodeSeason(episode) -
      episodeSeason(latestPlayableOverall);
    const episodeOrder = episodeNumber(episode) -
      episodeNumber(latestPlayableOverall);

    if (seasonOrder > 0 || (seasonOrder === 0 && episodeOrder > 0)) {
      latestPlayableOverall = episode;
    }
  }

  let item = null;

  // Keep the section useful: a series must have at least one playable episode.
  if (ongoingSeason && playable.length > 0) {
    const season = ongoingSeason.season;
    const completed = ongoingSeason.completedThrough;
    const total = ongoingSeason.total;
    const displayEpisode = ongoingSeason.displayEpisode;
    const displayStill = episodeStill(displayEpisode);
    const displayAirDate = episodeAirDate(displayEpisode);

    item = {
      ...series,
      Type: "Series",
      LatestSeason: String(season),
      OngoingSeason: String(season),
      LatestEpisode: String(completed),
      LatestLinkedEpisode: String(completed),
      SeasonEpisodeTotal: String(total),
      AvailableSeasonEpisodeCount: String(ongoingSeason.playableCount),
      LatestEpisodeLink: displayEpisode && isPlayable(displayEpisode)
        ? episodeLink(displayEpisode)
        : "",
      LatestEpisodeStill: valid(displayStill)
        ? displayStill
        : episodeStill(latestPlayableOverall),
      LatestEpisodeAirDate: valid(displayAirDate)
        ? displayAirDate
        : episodeAirDate(latestPlayableOverall),
      NewEpisodeBadge: makeProgressBadge(season, completed, total),
      AvailableEpisodeCount: String(playable.length),
      ExpectedEpisodeCount: String(
        Math.max(expectedEpisodeCount(series), episodes.length)
      ),
      IsIncomplete: "true",
      __bidamax_latest_episode: "true"
    };
  }

  return {
    id,
    signature,
    item,
    fallbackDate: item
      ? item.LatestEpisodeAirDate
      : episodeAirDate(latestPlayableOverall)
  };
}

function redisConfig() {
  return {
    url:
      process.env.KV_REST_API_URL ||
      process.env.UPSTASH_REDIS_REST_URL,
    token:
      process.env.KV_REST_API_TOKEN ||
      process.env.UPSTASH_REDIS_REST_TOKEN
  };
}

async function redis(command) {
  const { url, token } = redisConfig();

  if (!url || !token) {
    throw new Error("Redis REST environment variables are missing");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data || data.error) {
    throw new Error(data?.error || `Redis error (${response.status})`);
  }

  return data.result;
}

function cleanOrderState(value) {
  const state = value && typeof value === "object" ? value : {};
  const items = state.items && typeof state.items === "object"
    ? state.items
    : {};

  return {
    version: 2,
    items: { ...items }
  };
}

async function readOrderState() {
  try {
    const raw = await redis(["GET", ORDER_STATE_KEY]);

    if (raw) {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return cleanOrderState(parsed);
    }
  } catch (_) {
    // Memory fallback keeps the endpoint working without Redis.
  }

  return cleanOrderState(memoryOrderState);
}

async function saveOrderState(state) {
  memoryOrderState.version = 2;
  memoryOrderState.items = { ...state.items };

  try {
    await redis(["SET", ORDER_STATE_KEY, JSON.stringify(state)]);
  } catch (_) {
    // Sorting still works per warm instance when Redis is unavailable.
  }
}

function fallbackTimestamp(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function reconcileOrderState(snapshots, storedState, now) {
  const stored = cleanOrderState(storedState);
  const previousItems = stored.items;
  const hadPreviousState = Object.keys(previousItems).length > 0;
  const nextItems = {};
  const result = [];

  for (const [key, record] of Object.entries(previousItems)) {
    const lastSeenAt = number(record && record.lastSeenAt);

    if (lastSeenAt > 0 && now - lastSeenAt <= ORDER_STATE_MAX_AGE_MS) {
      nextItems[key] = { ...record };
    }
  }

  for (const snapshot of snapshots) {
    if (!snapshot || !valid(snapshot.id) || !valid(snapshot.signature)) {
      continue;
    }

    const previous = previousItems[snapshot.id];
    let changedAt = 0;

    if (previous && previous.signature === snapshot.signature) {
      changedAt = number(previous.changedAt);
    } else if (previous || hadPreviousState) {
      // Existing series changed, or a new series/episode file was added.
      changedAt = now;
    } else {
      // First deployment: use air dates only as a stable initial order.
      changedAt = fallbackTimestamp(snapshot.fallbackDate);
    }

    nextItems[snapshot.id] = {
      signature: snapshot.signature,
      changedAt,
      lastSeenAt: now
    };

    if (snapshot.item) {
      result.push({
        ...snapshot.item,
        LatestEpisodeChangedAt: String(changedAt)
      });
    }
  }

  return {
    items: result,
    state: {
      version: 2,
      items: nextItems
    }
  };
}

export function sortLatestItems(items) {
  items.sort((first, second) => {
    const changedOrder = number(second.LatestEpisodeChangedAt) -
      number(first.LatestEpisodeChangedAt);
    if (changedOrder !== 0) return changedOrder;

    const dateOrder = text(second.LatestEpisodeAirDate)
      .localeCompare(text(first.LatestEpisodeAirDate));
    if (dateOrder !== 0) return dateOrder;

    const seasonOrder = number(second.LatestSeason) - number(first.LatestSeason);
    if (seasonOrder !== 0) return seasonOrder;

    const episodeOrder = number(second.LatestEpisode) -
      number(first.LatestEpisode);
    if (episodeOrder !== 0) return episodeOrder;

    return text(first.Title).localeCompare(text(second.Title));
  });

  return items;
}

async function loadEpisodes(series) {
  const id = seriesId(series);

  if (!valid(id)) return null;

  const sourceTtl = positiveSeconds(
    process.env.LATEST_EPISODES_SOURCE_TTL,
    900
  );

  const result = await fetchCachedJson(
    getDataRawUrl(`episodes/${id}.json`),
    {
      // Dedicated cache key prevents the general one-hour episode cache from
      // delaying detection of newly added links in this aggregate.
      cacheKey: `latest-episodes-source:${id}`,
      ttlSeconds: sourceTtl,
      staleSeconds: 86400
    }
  );

  if (result.status !== 200) return null;

  try {
    return analyzeEpisodes(series, JSON.parse(result.body));
  } catch (_) {
    return null;
  }
}

async function buildLatestEpisodes() {
  const sourceTtl = positiveSeconds(
    process.env.LATEST_EPISODES_SOURCE_TTL,
    900
  );

  const seriesResult = await fetchCachedJson(
    getDataRawUrl("series.json"),
    {
      cacheKey: "latest-episodes-series-source",
      ttlSeconds: sourceTtl,
      staleSeconds: 86400
    }
  );

  if (seriesResult.status !== 200) {
    throw new Error(`Series source returned ${seriesResult.status}`);
  }

  const series = JSON.parse(seriesResult.body);
  if (!Array.isArray(series)) {
    throw new Error("Series source is not an array");
  }

  const ongoing = series.filter(isOngoing);
  const resolved = await Promise.all(ongoing.map(loadEpisodes));
  const snapshots = resolved.filter(Boolean);
  const storedState = await readOrderState();
  const reconciled = reconcileOrderState(
    snapshots,
    storedState,
    Date.now()
  );

  await saveOrderState(reconciled.state);
  sortLatestItems(reconciled.items);

  return reconciled.items.slice(0, 20);
}

async function refreshAggregate() {
  const now = Date.now();
  const ttlSeconds = positiveSeconds(
    process.env.LATEST_EPISODES_TTL,
    900
  );
  const staleSeconds = positiveSeconds(
    process.env.LATEST_EPISODES_STALE,
    86400
  );
  const items = await buildLatestEpisodes();

  aggregateCache.body = JSON.stringify(items);
  aggregateCache.generatedAt = now;
  aggregateCache.expiresAt = now + ttlSeconds * 1000;
  aggregateCache.staleUntil = now + staleSeconds * 1000;

  return {
    body: aggregateCache.body,
    cache: "REFRESH",
    generatedAt: now
  };
}

async function getAggregate() {
  const now = Date.now();

  if (aggregateCache.body && aggregateCache.expiresAt > now) {
    return {
      body: aggregateCache.body,
      cache: "HIT",
      generatedAt: aggregateCache.generatedAt
    };
  }

  try {
    if (!globalThis.__BIDAMAX_LATEST_EPISODES_INFLIGHT__) {
      globalThis.__BIDAMAX_LATEST_EPISODES_INFLIGHT__ = refreshAggregate();
    }

    return await globalThis.__BIDAMAX_LATEST_EPISODES_INFLIGHT__;
  } catch (error) {
    if (aggregateCache.body && aggregateCache.staleUntil > now) {
      return {
        body: aggregateCache.body,
        cache: "STALE",
        generatedAt: aggregateCache.generatedAt
      };
    }

    throw error;
  } finally {
    globalThis.__BIDAMAX_LATEST_EPISODES_INFLIGHT__ = null;
  }
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  try {
    const result = await getAggregate();
    const ttlSeconds = positiveSeconds(
      process.env.LATEST_EPISODES_TTL,
      900
    );
    const staleSeconds = positiveSeconds(
      process.env.LATEST_EPISODES_STALE,
      86400
    );

    sendJsonText(res, 200, result.body, {
      "Cache-Control":
        `public, s-maxage=${ttlSeconds}, stale-while-revalidate=${staleSeconds}`,
      "X-Bidamax-Cache": result.cache,
      "X-Bidamax-Generated-At": String(result.generatedAt || 0)
    });
  } catch (error) {
    sendJsonText(
      res,
      502,
      JSON.stringify({
        error: "Latest episodes unavailable",
        message: String(error && error.message ? error.message : error)
      }),
      { "Cache-Control": "no-store" }
    );
  }
}
