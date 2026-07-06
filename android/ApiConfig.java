package com.bidamax;

public class ApiConfig {

    // Palitan ito after mo ma-deploy sa Vercel.
    public static final String BASE = "https://YOUR-VERCEL-PROJECT.vercel.app/api";

    public static String movies() {
        return BASE + "/movies";
    }

    public static String series() {
        return BASE + "/series";
    }

    public static String seasons(String tmdbID) {
        return BASE + "/seasons?id=" + tmdbID;
    }

    public static String episodes(String tmdbID) {
        return BASE + "/episodes?id=" + tmdbID;
    }

    public static String version() {
        return BASE + "/version";
    }
}
