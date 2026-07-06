# BIDAMAX Vercel GitHub JSON Cache API

This Vercel project caches/proxies the current BIDAMAX GitHub JSON structure:

- `/api/movies` -> `database/movies.json`
- `/api/series` -> `database/series.json`
- `/api/seasons?id=TMDB_ID` -> `database/seasons/TMDB_ID.json`
- `/api/episodes?id=TMDB_ID` -> `database/episodes/TMDB_ID.json`
- `/api/version` -> `version.json` from the update repo
- `/api/health` -> API test route

## Default GitHub source

Content JSON:
- owner: `mlbb-injector`
- repo: `maui`
- branch: `main`
- base path: `database`

Version JSON:
- owner: `missnapokita`
- repo: `masterkit`
- branch: `main`
- file: `version.json`

## Optional Vercel Environment Variables

You can deploy without env variables because defaults are already set.

Optional variables:

- `CONTENT_GITHUB_OWNER`
- `CONTENT_GITHUB_REPO`
- `CONTENT_GITHUB_BRANCH`
- `CONTENT_GITHUB_BASE_PATH`
- `VERSION_GITHUB_OWNER`
- `VERSION_GITHUB_REPO`
- `VERSION_GITHUB_BRANCH`
- `GITHUB_TOKEN` optional, keep this only on Vercel, never inside Android app
- `BIDAMAX_API_KEY` optional, if set the API requires `?key=YOUR_KEY` or `x-api-key` header

## Android replacement

Add `ApiConfig.java` to:

`app/src/main/java/com/bidamax/ApiConfig.java`

Then replace direct GitHub URL strings:

```java
new java.net.URL(ApiConfig.movies())
new java.net.URL(ApiConfig.series())
new java.net.URL(ApiConfig.seasons(tmdbID))
new java.net.URL(ApiConfig.episodes(tmdbID))
new java.net.URL(ApiConfig.version())
```

After deployment, edit `ApiConfig.BASE`:

```java
public static final String BASE = "https://your-project.vercel.app/api";
```
