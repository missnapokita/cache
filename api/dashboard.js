export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const moviesUrl = "https://raw.githubusercontent.com/mlbb-injector/maui/main/database/movies.json";
    const seriesUrl = "https://raw.githubusercontent.com/mlbb-injector/maui/main/database/series.json";

    const episodesUrl = "https://api.github.com/repos/mlbb-injector/maui/contents/database/episodes?ref=main";
    const seasonsUrl = "https://api.github.com/repos/mlbb-injector/maui/contents/database/seasons?ref=main";

    const [moviesRes, seriesRes, episodesRes, seasonsRes] = await Promise.all([
      fetch(moviesUrl),
      fetch(seriesUrl),
      fetch(episodesUrl, {
        headers: { "User-Agent": "BIDAMAX-Admin" }
      }),
      fetch(seasonsUrl, {
        headers: { "User-Agent": "BIDAMAX-Admin" }
      })
    ]);

    const movies = await moviesRes.json();
    const series = await seriesRes.json();
    const episodes = await episodesRes.json();
    const seasons = await seasonsRes.json();

    const episodesCount = Array.isArray(episodes)
      ? episodes.filter(x => x.type === "file" && x.name.endsWith(".json")).length
      : 0;

    const seasonsCount = Array.isArray(seasons)
      ? seasons.filter(x => x.type === "file" && x.name.endsWith(".json")).length
      : 0;

    res.status(200).json({
      success: true,
      movies: Array.isArray(movies) ? movies.length : Object.keys(movies).length,
      series: Array.isArray(series) ? series.length : Object.keys(series).length,
      episodes: episodesCount,
      seasons: seasonsCount,
      cache: "Ready",
      updated_at: new Date().toISOString()
    });

  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
}
