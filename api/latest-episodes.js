import {
  checkAuth,
  fetchCachedJson,
  getDataRawUrl,
  sendJsonText
} from "./shared.js";

const aggregateCache = globalThis.__BIDAMAX_LATEST_EPISODES_CACHE__ || {
  body: "",
  expiresAt: 0,
  staleUntil: 0,
  generatedAt: 0
};

globalThis.__BIDAMAX_LATEST_EPISODES_CACHE__ = aggregateCache;

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

function episodeLink(episode) {
  return text(
    episode.link ||
    episode.Link ||
    episode.video_url ||
    episode.VideoUrl
  );
}

function isPlayable(episode) {
  return valid(episodeLink(episode));
}

function latestPlayableEpisode(episodes) {
  let latest = null;

  for (const episode of episodes) {
    if (!episode || !isPlayable(episode)) continue;

    if (!latest) {
      latest = episode;
      continue;
    }

    const currentSeason = number(episode.season || episode.Season);
    const currentEpisode = number(episode.episode || episode.Episode);
    const latestSeason = number(latest.season || latest.Season);
    const latestEpisode = number(latest.episode || latest.Episode);

    if (currentSeason > latestSeason ||
        (currentSeason === latestSeason && currentEpisode > latestEpisode)) {
      latest = episode;
    }
  }

  return latest;
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

function makeBadge(season, episode) {
  if (season > 1 && episode === 1) {
    return `New Season • S${season} E${episode}`;
  }

  return `New Episode • S${season} E${episode}`;
}

async function loadEpisodes(series) {
  const id = text(series.tmdbID || series.tmdbId || series.id);
  const expected = expectedEpisodeCount(series);

  if (!valid(id) || expected <= 0) return null;

  const result = await fetchCachedJson(
    getDataRawUrl(`episodes/${id}.json`),
    {
      cacheKey: `episodes:${id}`,
      ttlSeconds: Number(process.env.EPISODES_TTL || 3600),
      staleSeconds: 86400
    }
  );

  if (result.status !== 200) return null;

  let episodes;

  try {
    episodes = JSON.parse(result.body);
  } catch (_) {
    return null;
  }

  if (!Array.isArray(episodes)) return null;

  const playable = episodes.filter(isPlayable);

  // A fully uploaded series no longer belongs in this section.
  if (playable.length === 0 || playable.length >= expected) return null;

  const latest = latestPlayableEpisode(playable);
  if (!latest) return null;

  const season = number(latest.season || latest.Season);
  const episode = number(latest.episode || latest.Episode);

  if (season <= 0 || episode <= 0) return null;

  return {
    ...series,
    Type: "Series",
    LatestSeason: String(season),
    LatestEpisode: String(episode),
    LatestEpisodeLink: episodeLink(latest),
    LatestEpisodeStill: text(
      latest.still_path || latest.Still || latest.poster
    ),
    LatestEpisodeAirDate: text(
      latest.air_date || latest.AirDate || latest.date_added
    ),
    NewEpisodeBadge: makeBadge(season, episode),
    AvailableEpisodeCount: String(playable.length),
    ExpectedEpisodeCount: String(expected),
    IsIncomplete: "true",
    __bidamax_latest_episode: "true"
  };
}

async function buildLatestEpisodes() {
  const seriesResult = await fetchCachedJson(
    getDataRawUrl("series.json"),
    {
      cacheKey: "series",
      ttlSeconds: Number(process.env.SERIES_TTL || 1800),
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
  const items = resolved.filter(Boolean);

  items.sort((first, second) => {
    const dateOrder = text(second.LatestEpisodeAirDate)
      .localeCompare(text(first.LatestEpisodeAirDate));

    if (dateOrder !== 0) return dateOrder;

    const seasonOrder = number(second.LatestSeason) - number(first.LatestSeason);
    if (seasonOrder !== 0) return seasonOrder;

    return number(second.LatestEpisode) - number(first.LatestEpisode);
  });

  return items.slice(0, 20);
}

async function refreshAggregate() {
  const now = Date.now();
  const ttlSeconds = Number(process.env.LATEST_EPISODES_TTL || 900);
  const staleSeconds = Number(process.env.LATEST_EPISODES_STALE || 86400);
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

    sendJsonText(res, 200, result.body, {
      "Cache-Control": "public, s-maxage=900, stale-while-revalidate=86400",
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
